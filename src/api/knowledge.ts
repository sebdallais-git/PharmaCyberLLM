// API routes for knowledge base management

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { join } from "node:path";
import { writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import {
  ingestText,
  ingestFile,
  searchKnowledge,
  saveIndex,
  getStats,
} from "../services/knowledge-store.js";
import {
  addToChromaDB,
  chromaDocumentExists,
  getChromaStatus,
  isChromaDBAvailable,
  recreateChromaCollection,
} from "../services/chromadb-store.js";
import { RAW_DOCUMENTS_DIR, saveRawDocument } from "../services/raw-documents.js";
import { isSupportedFile, getSupportedExtensions, parseBuffer } from "../services/file-parser.js";
import {
  getRecentGaps,
  getGapStats,
  checkConfidence,
  resolveGap,
  markUnresolved,
  getGapById,
} from "../services/gap-detector.js";
import { getLlmClient } from "../services/llm-client.js";
import type { ChatMessage } from "../services/llm-client.js";
import { trackJob } from "../services/bench-mode.js";
import { isNeo4jAvailable, writeEntities } from "../services/graph-store.js";
import type { GraphEntity, GraphRelationship } from "../services/graph-store.js";

const router = Router();

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");

async function extractAndWriteEntities(text: string, source: string): Promise<void> {
  try {
    const neo4jOk = await isNeo4jAvailable();
    if (!neo4jOk) return;

    const extractionPrompt = `You are an entity extraction engine. Extract entities and relationships from this text.
Entity types: Company, Subsidiary, Drug, TherapeuticArea, ManufacturingSite, Country, RegulatoryBody, Regulation, ThreatActor, Attack, AttackVector, Vendor, Product, Technology
Return ONLY valid JSON: {"entities": [{"type": "...", "name": "...", "properties": {...}}], "relationships": [{"from": "...", "fromType": "...", "to": "...", "toType": "...", "type": "...", "properties": {...}}]}`;

    const response = await trackJob("graph-extraction", () =>
      getLlmClient().chat(
        [
          { role: "system", content: extractionPrompt },
          { role: "user", content: text.slice(0, 12000) },
        ],
        { temperature: 0.1 }
      )
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]) as {
      entities?: Array<{ type: string; name: string; properties: Record<string, unknown> }>;
      relationships?: Array<{
        from: string; fromType: string; to: string; toType: string;
        type: string; properties: Record<string, unknown>;
      }>;
    };

    const entities: GraphEntity[] = (data.entities ?? []).map((e) => ({
      type: e.type,
      name: e.name,
      properties: Object.fromEntries(
        Object.entries(e.properties ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")
      ),
    }));

    const relationships: GraphRelationship[] = (data.relationships ?? []).map((r) => ({
      from: r.from,
      fromType: r.fromType,
      to: r.to,
      toType: r.toType,
      type: r.type.replace(/\s+/g, "_").toUpperCase(),
      properties: Object.fromEntries(
        Object.entries(r.properties ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")
      ),
    }));

    if (entities.length > 0 || relationships.length > 0) {
      const result = await writeEntities(entities, relationships);
      console.log(`[Graph] Extracted ${result.nodesProcessed} nodes, ${result.relsProcessed} rels from ${source}`);
    }
  } catch (err) {
    console.error(`[Graph] Entity extraction failed for ${source}:`, err instanceof Error ? err.message : err);
  }
}

// Multer configuration for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/knowledge/stats - Knowledge base statistics
router.get("/stats", (_req: Request, res: Response): void => {
  res.json(getStats());
});

// POST /api/knowledge/search - Search the knowledge base
router.post("/search", async (req: Request, res: Response): Promise<void> => {
  const { query, topK } = req.body as { query: string; topK?: number };

  if (!query) {
    res.status(400).json({ error: "The 'query' field is required" });
    return;
  }

  try {
    const results = await searchKnowledge(query, topK ?? 5);
    res.json({ results });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
});

// POST /api/knowledge/ingest-text - Ingest raw text
router.post("/ingest-text", async (req: Request, res: Response): Promise<void> => {
  const { text, source } = req.body as { text: string; source: string };

  if (!text || !source) {
    res.status(400).json({ error: "The 'text' and 'source' fields are required" });
    return;
  }

  const added = ingestText(text, source);
  await saveIndex();

  // Async graph entity extraction (non-blocking)
  setImmediate(() => {
    extractAndWriteEntities(text, source).catch((err) =>
      console.error("[Graph] Async extraction error:", err)
    );
  });

  res.json({ message: `${added} chunks added from '${source}'`, added });
});

// POST /api/knowledge/upload - Upload a knowledge file
router.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    if (!isSupportedFile(file.originalname)) {
      res.status(400).json({
        error: `Unsupported file type. Accepted: ${getSupportedExtensions().join(", ")}`,
      });
      return;
    }

    // Save the file to knowledge/
    await mkdir(KNOWLEDGE_DIR, { recursive: true });
    const destPath = join(KNOWLEDGE_DIR, file.originalname);
    await writeFile(destPath, file.buffer);

    // Parse and ingest
    const text = await parseBuffer(file.buffer, file.originalname);
    const added = await ingestText(text, file.originalname);
    await saveIndex();

    // Async graph entity extraction (non-blocking)
    setImmediate(() => {
      extractAndWriteEntities(text, file.originalname).catch((err) =>
        console.error("[Graph] Async extraction error:", err)
      );
    });

    res.json({
      message: `File '${file.originalname}' ingested (${added} chunks)`,
      added,
    });
  }
);

// GET /api/knowledge/status - ChromaDB knowledge base status
router.get("/status", async (_req: Request, res: Response): Promise<void> => {
  try {
    const available = await isChromaDBAvailable();
    if (!available) {
      res.status(503).json({
        error: "ChromaDB server is not reachable",
        chromadb: false,
      });
      return;
    }

    const status = await getChromaStatus();
    res.json({
      chromadb: true,
      totalChunks: status.totalChunks,
      totalDocuments: status.sources.length,
      lastAdded: status.lastAdded,
      sources: status.sources,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/knowledge/add - Add content to ChromaDB via URL or raw text
router.post("/add", async (req: Request, res: Response): Promise<void> => {
  const { url, text, source } = req.body as {
    url?: string;
    text?: string;
    source?: string;
  };

  if (!url && !text) {
    res.status(400).json({ error: "Provide either 'url' or 'text'" });
    return;
  }

  try {
    const available = await isChromaDBAvailable();
    if (!available) {
      res.status(503).json({ error: "ChromaDB server is not reachable" });
      return;
    }

    // Ingest from URL
    if (url) {
      // Check for duplicates
      const exists = await chromaDocumentExists(url);
      if (exists) {
        res.json({ message: "Document already exists in ChromaDB", added: 0, source: url });
        return;
      }

      // Fetch and extract text from the URL
      console.log(`[Knowledge] Fetching URL: ${url}`);
      const pageResp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!pageResp.ok) {
        res.status(400).json({ error: `Failed to fetch URL (${pageResp.status})` });
        return;
      }

      const html = await pageResp.text();

      // Basic HTML-to-text extraction (strip tags, scripts, styles)
      const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000);

      // Save raw content for future re-indexing
      await saveRawDocument(url, cleaned, { type: "url" });

      const added = await addToChromaDB(
        [cleaned],
        [{ source: url }]
      );

      console.log(`[Knowledge] Added ${added} chunks from URL: ${url}`);
      res.json({ message: `Added ${added} chunks from URL`, added, source: url });
      return;
    }

    // Ingest raw text
    if (text) {
      const sourceName = source ?? `text-${Date.now()}`;

      // Save raw content for future re-indexing
      await saveRawDocument(sourceName, text, { type: "text" });

      const added = await addToChromaDB(
        [text],
        [{ source: sourceName }]
      );

      console.log(`[Knowledge] Added ${added} chunks from text (source: ${sourceName})`);
      res.json({ message: `Added ${added} chunks`, added, source: sourceName });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Knowledge] Add failed:", message);
    res.status(500).json({ error: message });
  }
});

// GET /api/knowledge/gaps - Recent knowledge gaps
router.get("/gaps", (_req: Request, res: Response): void => {
  try {
    const gaps = getRecentGaps(50);
    res.json({ gaps });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/knowledge/gaps/stats - Gap statistics
router.get("/gaps/stats", (_req: Request, res: Response): void => {
  try {
    const stats = getGapStats();
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/knowledge/gaps/check-resolution - Re-check if a gap is now resolved
router.post("/gaps/check-resolution", async (req: Request, res: Response): Promise<void> => {
  const { gap_id, original_query, search_topic } = req.body as {
    gap_id?: number;
    original_query?: string;
    search_topic?: string;
  };

  if (!gap_id || !original_query) {
    res.status(400).json({ error: "gap_id and original_query are required" });
    return;
  }

  try {
    // Verify gap exists
    const gap = getGapById(gap_id);
    if (!gap) {
      res.status(404).json({ error: `Gap ${gap_id} not found` });
      return;
    }

    // Re-ask through full RAG pipeline: query ChromaDB → build prompt → call Gemma
    let context = "";
    try {
      const chromaAvailable = await isChromaDBAvailable();
      if (chromaAvailable) {
        const { searchChromaDB } = await import("../services/chromadb-store.js");
        const results = await searchChromaDB(original_query, 5);
        if (results.length > 0) {
          context = "\n\nRelevant context from the knowledge base:\n" +
            results.map((r) => `[Source: ${String(r.metadata.source ?? "unknown")}]\n${r.document}`)
              .join("\n\n---\n\n");
        }
      }
    } catch {
      // Fall back to in-memory
    }

    if (!context) {
      const memResults = await searchKnowledge(original_query, 8);
      if (memResults.length > 0) {
        context = "\n\nRelevant context from the knowledge base:\n" +
          memResults.map((c) => `[Source: ${c.source}]\n${c.content}`).join("\n\n---\n\n");
      }
    }

    const systemPrompt = `You are PharmaBot, an expert in pharmaceutical cybersecurity. Use the following context to answer the question accurately and specifically.${context}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: original_query },
    ];

    const newResponse = await trackJob("gap-resolution", () => getLlmClient().chat(messages));

    // Run confidence check on the new response
    const confidence = await trackJob("gap-resolution", () => checkConfidence(original_query, newResponse));

    if (confidence.confident) {
      resolveGap(gap_id, newResponse);
      console.log(`[Gap Resolution] Gap ${gap_id} RESOLVED for topic: "${search_topic ?? ""}"`);
      res.json({
        resolved: true,
        new_response: newResponse,
        confidence_reason: confidence.reason,
      });
    } else {
      markUnresolved(gap_id);
      console.log(`[Gap Resolution] Gap ${gap_id} still UNRESOLVED for topic: "${search_topic ?? ""}"`);
      res.json({
        resolved: false,
        new_response: newResponse,
        confidence_reason: confidence.reason,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Gap Resolution] Error checking gap ${gap_id}:`, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// POST /api/knowledge/reindex - Re-chunk and re-embed all raw documents
router.post("/reindex", async (_req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();

  try {
    const available = await isChromaDBAvailable();
    if (!available) {
      res.status(503).json({ error: "ChromaDB server is not reachable" });
      return;
    }

    // Read all raw documents
    let files: string[];
    try {
      await mkdir(RAW_DOCUMENTS_DIR, { recursive: true });
      files = await readdir(RAW_DOCUMENTS_DIR);
    } catch {
      res.status(404).json({ error: "No raw_documents directory found" });
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length === 0) {
      res.json({
        message: "No raw documents to re-index",
        documents_processed: 0,
        chunks_created: 0,
        time_seconds: 0,
      });
      return;
    }

    // Delete and recreate the ChromaDB collection
    console.log("[Reindex] Deleting and recreating ChromaDB collection...");
    await recreateChromaCollection();

    // Re-ingest all documents
    let totalChunks = 0;
    let docsProcessed = 0;

    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(RAW_DOCUMENTS_DIR, file), "utf-8");
        const doc = JSON.parse(raw) as {
          source: string;
          content: string;
          metadata?: Record<string, unknown>;
        };

        const added = await addToChromaDB(
          [doc.content],
          [{ source: doc.source, ...(doc.metadata ?? {}) }]
        );

        totalChunks += added;
        docsProcessed++;
        console.log(`[Reindex] ${file}: ${added} chunks (source: ${doc.source})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[Reindex] Failed to process ${file}: ${msg}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[Reindex] Complete: ${docsProcessed} documents, ${totalChunks} chunks in ${elapsed}s`
    );

    res.json({
      message: "Re-indexing complete",
      documents_processed: docsProcessed,
      chunks_created: totalChunks,
      time_seconds: parseFloat(elapsed),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Reindex] Failed:", message);
    res.status(500).json({ error: message });
  }
});

export default router;

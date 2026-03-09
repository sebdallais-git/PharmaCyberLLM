// Routes API pour la gestion de la base de connaissances

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
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
} from "../services/chromadb-store.js";
import { isSupportedFile, getSupportedExtensions, parseBuffer } from "../services/file-parser.js";
import { getRecentGaps, getGapStats } from "../services/gap-detector.js";

const router = Router();

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");

// Configuration multer pour l'upload de fichiers
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/knowledge/stats - Statistiques de la base
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

  const results = await searchKnowledge(query, topK ?? 5);
  res.json({ results });
});

// POST /api/knowledge/ingest-text - Ingère du texte brut
router.post("/ingest-text", async (req: Request, res: Response): Promise<void> => {
  const { text, source } = req.body as { text: string; source: string };

  if (!text || !source) {
    res.status(400).json({ error: "Les champs 'text' et 'source' sont requis" });
    return;
  }

  const added = ingestText(text, source);
  await saveIndex();
  res.json({ message: `${added} chunks ajoutés depuis '${source}'`, added });
});

// POST /api/knowledge/upload - Upload un fichier de connaissances
router.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Aucun fichier fourni" });
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

    res.json({
      message: `Fichier '${file.originalname}' ingéré (${added} chunks)`,
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

// GET /api/knowledge/gaps - Lacunes de connaissances récentes
router.get("/gaps", (_req: Request, res: Response): void => {
  try {
    const gaps = getRecentGaps(50);
    res.json({ gaps });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/knowledge/gaps/stats - Statistiques des lacunes
router.get("/gaps/stats", (_req: Request, res: Response): void => {
  try {
    const stats = getGapStats();
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

export default router;

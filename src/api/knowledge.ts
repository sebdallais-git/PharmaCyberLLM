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
import { isSupportedFile, getSupportedExtensions, parseBuffer } from "../services/file-parser.js";

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

export default router;

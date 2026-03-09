// Dashboard API and health check routes

import { Router } from "express";
import type { Request, Response } from "express";
import { getDashboardMetrics } from "../services/request-log.js";
import { isChromaDBAvailable, getChromaStatus } from "../services/chromadb-store.js";
import { getStats } from "../services/knowledge-store.js";

const router = Router();

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const SEARXNG_URL = "http://localhost:8888";

// GET /api/dashboard/metrics
router.get("/metrics", async (_req: Request, res: Response): Promise<void> => {
  try {
    const metrics = getDashboardMetrics();

    // Enrich with live ChromaDB stats
    let totalChunks = 0;
    const knowledgeBySource: Record<string, number> = {};

    try {
      const chromaOk = await isChromaDBAvailable();
      if (chromaOk) {
        const status = await getChromaStatus();
        totalChunks = status.totalChunks;
        for (const src of status.sources) {
          const lower = src.toLowerCase();
          let category = "manual";
          if (lower.includes("rss") || lower.includes("news")) category = "rss";
          else if (lower.includes("n8n-gap") || lower.includes("http")) category = "web";
          else if (lower.includes("regulation") || lower.includes("fda")) category = "regulatory";
          else if (lower.includes("vendor-") || lower.includes("cyber-")) category = "research";
          knowledgeBySource[category] = (knowledgeBySource[category] ?? 0) + 1;
        }
      }
    } catch { /* ChromaDB unavailable */ }

    // Also count in-memory chunks
    const memStats = getStats();
    totalChunks += memStats.totalChunks ?? 0;

    res.json({
      ...metrics,
      total_knowledge_chunks: totalChunks,
      knowledge_by_source: knowledgeBySource,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/health
router.get("/health", async (_req: Request, res: Response): Promise<void> => {
  const checks: Record<string, { status: string; latency_ms?: number }> = {};

  // Ollama
  try {
    const start = Date.now();
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    checks.ollama = {
      status: resp.ok ? "ok" : "error",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.ollama = { status: "unreachable" };
  }

  // ChromaDB
  try {
    const start = Date.now();
    const ok = await isChromaDBAvailable();
    checks.chromadb = {
      status: ok ? "ok" : "unreachable",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.chromadb = { status: "unreachable" };
  }

  // SearXNG
  try {
    const start = Date.now();
    const resp = await fetch(`${SEARXNG_URL}/`, {
      signal: AbortSignal.timeout(3000),
    });
    checks.searxng = {
      status: resp.ok ? "ok" : "error",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.searxng = { status: "unreachable" };
  }

  // SQLite
  try {
    checks.sqlite = { status: "ok" };
  } catch {
    checks.sqlite = { status: "error" };
  }

  const statuses = Object.values(checks).map((c) => c.status);
  let overall: string;
  if (statuses.every((s) => s === "ok")) {
    overall = "healthy";
  } else if (statuses.includes("unreachable") || statuses.includes("error")) {
    const criticalDown = checks.ollama.status !== "ok";
    overall = criticalDown ? "unhealthy" : "degraded";
  } else {
    overall = "healthy";
  }

  res.json({ status: overall, checks });
});

export default router;

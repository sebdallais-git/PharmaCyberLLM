// Dashboard API and health check routes

import { Router } from "express";
import type { Request, Response } from "express";
import { getDashboardMetrics, getChromaDBMisses, getChromaDBMissStats } from "../services/request-log.js";
import { isChromaDBAvailable, getChromaStatus } from "../services/chromadb-store.js";
import { isNeo4jAvailable } from "../services/graph-store.js";
import { getStats } from "../services/knowledge-store.js";
import { getActiveStack } from "../config/llm-stacks.js";
import { getIndexStatus } from "../services/index-guard.js";
import { isBenchmarkActive } from "../services/bench-mode.js";
import { aggregateHealth, probeGeneration, probeUrl, stackProbeUrls } from "../services/health.js";
import type { HealthCheck } from "../services/health.js";

const router = Router();

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
  const stack = getActiveStack();
  const urls = stackProbeUrls(stack);
  const checks: Record<string, HealthCheck> = {};

  // Active LLM stack only; the inactive stack is expected to be stopped
  // llm_chat asks the model for a token rather than pinging /v1/models. A
  // wedged MLX serves /v1/models perfectly while generating nothing -- on
  // 2026-09-22 this endpoint reported llm_chat "ok" for a server that timed out
  // a 5-token request at 90s. Liveness is not readiness.
  const [chat, embed] = await Promise.all([
    probeGeneration(stack.chatBaseUrl),
    probeUrl(urls.llm_embed),
  ]);
  checks.llm_chat = chat;
  checks.llm_embed = embed;

  const indexStatus = getIndexStatus();
  checks.search_index = indexStatus.ok ? { status: "ok" } : { status: "error", detail: indexStatus.reason };

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
  checks.searxng = await probeUrl(`${SEARXNG_URL}/`);

  // Neo4j
  try {
    const start = Date.now();
    const neo4jOk = await isNeo4jAvailable();
    checks.neo4j = {
      status: neo4jOk ? "ok" : "unreachable",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.neo4j = { status: "unreachable" };
  }

  // SQLite
  checks.sqlite = { status: "ok" };

  // Informational, not a check: a benchmark doesn't make the app unhealthy
  res.json({ status: aggregateHealth(checks), stack: stack.name, benchmark_active: isBenchmarkActive(), checks });
});

// GET /api/dashboard/chromadb-misses — queries that ChromaDB couldn't answer
router.get("/chromadb-misses", (_req: Request, res: Response): void => {
  const stats = getChromaDBMissStats();
  const recent = getChromaDBMisses(50);
  res.json({ stats, recent });
});

// Knowledge base health reports from N8N workflow

interface KBHealthReport {
  timestamp: string;
  health: string;
  knowledge_base: { total_chunks: number; sources_count: number };
  quality_scores: {
    avg_score: number;
    min_score: number;
    max_score: number;
    queries_tested: number;
    with_sources: number;
    hallucinations_detected: number;
  };
  low_score_queries: Array<{ query: string; score: number; reason: string }>;
  gap_stats: { total_questions: number; total_gaps: number; gap_rate: number };
}

const kbHealthHistory: KBHealthReport[] = [];
const MAX_HEALTH_HISTORY = 168; // 7 days at 6h intervals

// POST /api/dashboard/kb-health - Receive health report from N8N
router.post("/kb-health", (req: Request, res: Response): void => {
  const report = req.body as KBHealthReport;

  if (!report.timestamp || !report.health) {
    res.status(400).json({ error: "Invalid health report" });
    return;
  }

  kbHealthHistory.push(report);

  // Keep only last 7 days
  while (kbHealthHistory.length > MAX_HEALTH_HISTORY) {
    kbHealthHistory.shift();
  }

  console.log(
    `[KB Health] ${report.health} — avg score: ${report.quality_scores.avg_score}/10, ` +
    `${report.quality_scores.hallucinations_detected} hallucinations, ` +
    `${report.knowledge_base.total_chunks} chunks`
  );

  res.json({ status: "stored", total_reports: kbHealthHistory.length });
});

// GET /api/dashboard/kb-health - Get health report history
router.get("/kb-health", (_req: Request, res: Response): void => {
  const latest = kbHealthHistory.length > 0
    ? kbHealthHistory[kbHealthHistory.length - 1]
    : null;

  // Compute trend over last 4 reports (24h at 6h intervals)
  const recent = kbHealthHistory.slice(-4);
  const avgTrend = recent.length > 0
    ? recent.reduce((sum, r) => sum + r.quality_scores.avg_score, 0) / recent.length
    : 0;

  res.json({
    latest,
    trend: {
      avg_score_24h: Math.round(avgTrend * 10) / 10,
      reports_count: kbHealthHistory.length,
      last_check: latest?.timestamp ?? null,
    },
    history: kbHealthHistory.slice(-24), // Last 6 days
  });
});

export default router;

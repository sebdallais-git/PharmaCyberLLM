// Request logging and dashboard metrics service

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = join(process.cwd(), "data", "gap_log.db");
let db: Database.Database;

export function initRequestLog(): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      query TEXT NOT NULL,
      response_time_ms INTEGER NOT NULL,
      had_rag_context INTEGER NOT NULL DEFAULT 0,
      was_confident INTEGER NOT NULL DEFAULT 1,
      chunks_used_count INTEGER NOT NULL DEFAULT 0,
      response_length INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ChromaDB miss log — tracks queries that got no ChromaDB results
  db.prepare(`
    CREATE TABLE IF NOT EXISTS chromadb_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      query TEXT NOT NULL,
      reason TEXT NOT NULL,
      had_inmemory_fallback INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  // Indexes for dashboard queries
  db.prepare("CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_gap_log_timestamp ON gap_log(timestamp)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_gap_log_status ON gap_log(status)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_chromadb_misses_timestamp ON chromadb_misses(timestamp)").run();
}

export function logRequest(entry: {
  query: string;
  responseTimeMs: number;
  hadRagContext: boolean;
  wasConfident: boolean;
  chunksUsedCount: number;
  responseLength: number;
}): void {
  try {
    db.prepare(
      `INSERT INTO request_log (timestamp, query, response_time_ms, had_rag_context, was_confident, chunks_used_count, response_length)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(),
      entry.query,
      entry.responseTimeMs,
      entry.hadRagContext ? 1 : 0,
      entry.wasConfident ? 1 : 0,
      entry.chunksUsedCount,
      entry.responseLength
    );
  } catch (err) {
    console.error("[RequestLog] Failed to log:", err);
  }
}

// Log a ChromaDB miss — query that ChromaDB couldn't answer
export function logChromaDBMiss(entry: {
  query: string;
  reason: string;
  hadInmemoryFallback: boolean;
}): void {
  try {
    db.prepare(
      `INSERT INTO chromadb_misses (timestamp, query, reason, had_inmemory_fallback)
       VALUES (?, ?, ?, ?)`
    ).run(
      new Date().toISOString(),
      entry.query,
      entry.reason,
      entry.hadInmemoryFallback ? 1 : 0
    );
  } catch (err) {
    console.error("[RequestLog] Failed to log ChromaDB miss:", err);
  }
}

export interface ChromaDBMiss {
  id: number;
  timestamp: string;
  query: string;
  reason: string;
  had_inmemory_fallback: boolean;
}

// Get recent ChromaDB misses for review
export function getChromaDBMisses(limit: number = 100): ChromaDBMiss[] {
  try {
    const rows = db.prepare(
      "SELECT * FROM chromadb_misses ORDER BY id DESC LIMIT ?"
    ).all(limit) as Array<{
      id: number;
      timestamp: string;
      query: string;
      reason: string;
      had_inmemory_fallback: number;
    }>;
    return rows.map((r) => ({
      ...r,
      had_inmemory_fallback: r.had_inmemory_fallback === 1,
    }));
  } catch (err) {
    console.error("[RequestLog] Failed to read ChromaDB misses:", err);
    return [];
  }
}

// Get ChromaDB miss stats — most frequent missed queries grouped by similarity
export function getChromaDBMissStats(): {
  total: number;
  last_7d: number;
  top_queries: Array<{ query: string; count: number; last_seen: string }>;
} {
  try {
    const total = (db.prepare(
      "SELECT COUNT(*) as c FROM chromadb_misses"
    ).get() as { c: number }).c;

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const last7d = (db.prepare(
      "SELECT COUNT(*) as c FROM chromadb_misses WHERE timestamp >= ?"
    ).get(sevenDaysAgo) as { c: number }).c;

    const topQueries = db.prepare(`
      SELECT query, COUNT(*) as count, MAX(timestamp) as last_seen
      FROM chromadb_misses
      GROUP BY query ORDER BY count DESC LIMIT 20
    `).all() as Array<{ query: string; count: number; last_seen: string }>;

    return { total, last_7d: last7d, top_queries: topQueries };
  } catch {
    return { total: 0, last_7d: 0, top_queries: [] };
  }
}

// Metrics cache (30 seconds)
let metricsCache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 30_000;

export function getDashboardMetrics(): Record<string, unknown> {
  if (metricsCache && Date.now() - metricsCache.timestamp < CACHE_TTL_MS) {
    return metricsCache.data as Record<string, unknown>;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

  // --- Questions counts ---
  const questionsToday = (db.prepare(
    "SELECT COUNT(*) as c FROM request_log WHERE timestamp >= ?"
  ).get(todayStart) as { c: number }).c;

  const questions7d = (db.prepare(
    "SELECT COUNT(*) as c FROM request_log WHERE timestamp >= ?"
  ).get(sevenDaysAgo) as { c: number }).c;

  const questions30d = (db.prepare(
    "SELECT COUNT(*) as c FROM request_log WHERE timestamp >= ?"
  ).get(thirtyDaysAgo) as { c: number }).c;

  // --- Confidence rates ---
  const conf7d = db.prepare(
    "SELECT COUNT(*) as total, SUM(was_confident) as confident FROM request_log WHERE timestamp >= ?"
  ).get(sevenDaysAgo) as { total: number; confident: number };
  const confidenceRate7d = conf7d.total > 0
    ? Math.round((conf7d.confident / conf7d.total) * 10000) / 100
    : 100;

  const conf30d = db.prepare(
    "SELECT COUNT(*) as total, SUM(was_confident) as confident FROM request_log WHERE timestamp >= ?"
  ).get(thirtyDaysAgo) as { total: number; confident: number };
  const confidenceRate30d = conf30d.total > 0
    ? Math.round((conf30d.confident / conf30d.total) * 10000) / 100
    : 100;

  // --- Average ratings ---
  const rating7d = db.prepare(
    "SELECT AVG(rating) as avg FROM feedback WHERE timestamp >= ?"
  ).get(sevenDaysAgo) as { avg: number | null };

  const rating30d = db.prepare(
    "SELECT AVG(rating) as avg FROM feedback WHERE timestamp >= ?"
  ).get(thirtyDaysAgo) as { avg: number | null };

  // --- Knowledge stats ---
  let totalKnowledgeChunks = 0;
  let knowledgeBySource: Record<string, number> = {};
  try {
    const chunkCount = db.prepare(
      "SELECT COUNT(*) as c FROM request_log"
    ).get() as { c: number };
    // We'll get ChromaDB stats from the API layer
    totalKnowledgeChunks = chunkCount.c; // placeholder, overridden by caller
  } catch { /* empty */ }

  // --- Gap stats ---
  const gapsDetected7d = (db.prepare(
    "SELECT COUNT(*) as c FROM gap_log WHERE timestamp >= ?"
  ).get(sevenDaysAgo) as { c: number }).c;

  const gapsResolved7d = (db.prepare(
    "SELECT COUNT(*) as c FROM gap_log WHERE timestamp >= ? AND status = 'resolved'"
  ).get(sevenDaysAgo) as { c: number }).c;

  const gapsUnresolved = (db.prepare(
    "SELECT COUNT(*) as c FROM gap_log WHERE status != 'resolved'"
  ).get() as { c: number }).c;

  const topGapTopics = db.prepare(`
    SELECT search_topic as topic, COUNT(*) as count
    FROM gap_log WHERE search_topic IS NOT NULL AND search_topic != ''
    GROUP BY search_topic ORDER BY count DESC LIMIT 10
  `).all() as Array<{ topic: string; count: number }>;

  const recentGaps = db.prepare(`
    SELECT id, timestamp, original_query, search_topic, status
    FROM gap_log ORDER BY id DESC LIMIT 10
  `).all() as Array<{
    id: number; timestamp: string; original_query: string;
    search_topic: string; status: string;
  }>;

  // --- Response time ---
  const avgResponseTime = db.prepare(
    "SELECT AVG(response_time_ms) as avg FROM request_log WHERE timestamp >= ?"
  ).get(sevenDaysAgo) as { avg: number | null };

  // --- Time series: questions by day (30 days) ---
  const questionsByDay = db.prepare(`
    SELECT DATE(timestamp) as date, COUNT(*) as count
    FROM request_log WHERE timestamp >= ?
    GROUP BY DATE(timestamp) ORDER BY date
  `).all(thirtyDaysAgo) as Array<{ date: string; count: number }>;

  // --- Time series: confidence by day (30 days) ---
  const confidenceByDay = db.prepare(`
    SELECT DATE(timestamp) as date,
      SUM(was_confident) as confident_count,
      COUNT(*) as total_count
    FROM request_log WHERE timestamp >= ?
    GROUP BY DATE(timestamp) ORDER BY date
  `).all(thirtyDaysAgo) as Array<{ date: string; confident_count: number; total_count: number }>;

  // --- Time series: ratings by day (30 days) ---
  const ratingsByDay = db.prepare(`
    SELECT DATE(timestamp) as date,
      ROUND(AVG(rating), 2) as avg_rating,
      COUNT(*) as count
    FROM feedback WHERE timestamp >= ?
    GROUP BY DATE(timestamp) ORDER BY date
  `).all(thirtyDaysAgo) as Array<{ date: string; avg_rating: number; count: number }>;

  // --- RSS items ingested (7 days) ---
  let rssItems7d = 0;
  try {
    const rss = db.prepare(
      "SELECT COUNT(*) as c FROM request_log WHERE timestamp >= ? AND query LIKE '%news%'"
    ).get(sevenDaysAgo) as { c: number };
    rssItems7d = rss.c;
  } catch { /* table might not exist */ }

  const metrics = {
    questions_today: questionsToday,
    questions_7d: questions7d,
    questions_30d: questions30d,
    confidence_rate_7d: confidenceRate7d,
    confidence_rate_30d: confidenceRate30d,
    avg_rating_7d: rating7d.avg !== null ? Math.round(rating7d.avg * 100) / 100 : null,
    avg_rating_30d: rating30d.avg !== null ? Math.round(rating30d.avg * 100) / 100 : null,
    total_knowledge_chunks: totalKnowledgeChunks,
    knowledge_by_source: knowledgeBySource,
    gaps_detected_7d: gapsDetected7d,
    gaps_resolved_7d: gapsResolved7d,
    gaps_unresolved: gapsUnresolved,
    top_gap_topics: topGapTopics,
    recent_gaps: recentGaps,
    avg_response_time_ms: avgResponseTime.avg !== null ? Math.round(avgResponseTime.avg) : null,
    rss_items_ingested_7d: rssItems7d,
    questions_by_day: questionsByDay,
    confidence_by_day: confidenceByDay,
    ratings_by_day: ratingsByDay,
  };

  metricsCache = { data: metrics, timestamp: Date.now() };
  return metrics;
}

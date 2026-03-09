// Feedback storage using the same SQLite DB as gap detection

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = join(process.cwd(), "data", "gap_log.db");

let db: Database.Database;

export function initFeedbackDB(): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      query TEXT NOT NULL,
      response TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      had_rag_context INTEGER NOT NULL DEFAULT 0,
      chunk_ids_used TEXT NOT NULL DEFAULT '[]',
      response_id TEXT
    )
  `);
}

export interface FeedbackEntry {
  query: string;
  response: string;
  rating: number;
  comment?: string;
  hadRagContext: boolean;
  chunkIds: string[];
  responseId?: string;
}

export function addFeedback(entry: FeedbackEntry): number {
  const result = db.prepare(
    `INSERT INTO feedback (timestamp, query, response, rating, comment, had_rag_context, chunk_ids_used, response_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    entry.query,
    entry.response,
    entry.rating,
    entry.comment ?? null,
    entry.hadRagContext ? 1 : 0,
    JSON.stringify(entry.chunkIds),
    entry.responseId ?? null
  );
  return result.lastInsertRowid as number;
}

export interface FeedbackStats {
  avg_rating_overall: number | null;
  avg_rating_rag: number | null;
  avg_rating_no_rag: number | null;
  avg_rating_7d: number | null;
  avg_rating_all_time: number | null;
  total_feedback: number;
  worst_topics: Array<{ topic: string; avg_rating: number; count: number }>;
  best_topics: Array<{ topic: string; avg_rating: number; count: number }>;
}

export function getFeedbackStats(): FeedbackStats {
  const overall = db.prepare(
    "SELECT AVG(rating) as avg, COUNT(*) as count FROM feedback"
  ).get() as { avg: number | null; count: number };

  const rag = db.prepare(
    "SELECT AVG(rating) as avg FROM feedback WHERE had_rag_context = 1"
  ).get() as { avg: number | null };

  const noRag = db.prepare(
    "SELECT AVG(rating) as avg FROM feedback WHERE had_rag_context = 0"
  ).get() as { avg: number | null };

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = db.prepare(
    "SELECT AVG(rating) as avg FROM feedback WHERE timestamp > ?"
  ).get(sevenDaysAgo) as { avg: number | null };

  // Extract first few keywords from query as "topic" for grouping
  const worst = db.prepare(`
    SELECT
      SUBSTR(query, 1, 60) as topic,
      AVG(rating) as avg_rating,
      COUNT(*) as count
    FROM feedback
    GROUP BY LOWER(SUBSTR(query, 1, 60))
    HAVING count >= 1
    ORDER BY avg_rating ASC
    LIMIT 10
  `).all() as Array<{ topic: string; avg_rating: number; count: number }>;

  const best = db.prepare(`
    SELECT
      SUBSTR(query, 1, 60) as topic,
      AVG(rating) as avg_rating,
      COUNT(*) as count
    FROM feedback
    GROUP BY LOWER(SUBSTR(query, 1, 60))
    HAVING count >= 1
    ORDER BY avg_rating DESC
    LIMIT 10
  `).all() as Array<{ topic: string; avg_rating: number; count: number }>;

  const round = (v: number | null): number | null =>
    v !== null ? Math.round(v * 100) / 100 : null;

  return {
    avg_rating_overall: round(overall.avg),
    avg_rating_rag: round(rag.avg),
    avg_rating_no_rag: round(noRag.avg),
    avg_rating_7d: round(recent.avg),
    avg_rating_all_time: round(overall.avg),
    total_feedback: overall.count,
    worst_topics: worst.map((t) => ({ ...t, avg_rating: Math.round(t.avg_rating * 100) / 100 })),
    best_topics: best.map((t) => ({ ...t, avg_rating: Math.round(t.avg_rating * 100) / 100 })),
  };
}

export interface LowRatedEntry {
  id: number;
  timestamp: string;
  query: string;
  response: string;
  rating: number;
  comment: string | null;
  chunk_ids_used: string[];
}

export function getLowRatedFeedback(): LowRatedEntry[] {
  const rows = db.prepare(
    `SELECT id, timestamp, query, response, rating, comment, chunk_ids_used
     FROM feedback
     WHERE rating <= 2
     ORDER BY timestamp DESC
     LIMIT 50`
  ).all() as Array<{
    id: number;
    timestamp: string;
    query: string;
    response: string;
    rating: number;
    comment: string | null;
    chunk_ids_used: string;
  }>;

  return rows.map((r) => ({
    ...r,
    chunk_ids_used: JSON.parse(r.chunk_ids_used) as string[],
  }));
}

export interface WeeklyDigest {
  period_start: string;
  period_end: string;
  total_questions: number;
  total_gaps_detected: number;
  gaps_resolved: number;
  gaps_unresolved: number;
  avg_user_rating: number | null;
  top_topics_by_volume: Array<{ topic: string; count: number }>;
  topics_needing_improvement: Array<{ topic: string; avg_rating: number | null; unresolved_gaps: number; score: number }>;
}

export function getWeeklyDigest(): WeeklyDigest {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = weekAgo.toISOString();
  const periodEnd = now.toISOString();

  // Total feedback entries this week (proxy for questions asked)
  const feedbackCount = db.prepare(
    "SELECT COUNT(*) as count FROM feedback WHERE timestamp > ?"
  ).get(periodStart) as { count: number };

  // Gap stats this week
  const gapsDetected = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE timestamp > ?"
  ).get(periodStart) as { count: number };

  const gapsResolved = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE timestamp > ? AND status = 'resolved'"
  ).get(periodStart) as { count: number };

  const gapsUnresolved = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE timestamp > ? AND status != 'resolved'"
  ).get(periodStart) as { count: number };

  // Average rating this week
  const avgRating = db.prepare(
    "SELECT AVG(rating) as avg FROM feedback WHERE timestamp > ?"
  ).get(periodStart) as { avg: number | null };

  // Top 5 topics by question volume (from feedback)
  const topTopics = db.prepare(`
    SELECT SUBSTR(query, 1, 60) as topic, COUNT(*) as count
    FROM feedback
    WHERE timestamp > ?
    GROUP BY LOWER(SUBSTR(query, 1, 60))
    ORDER BY count DESC
    LIMIT 5
  `).all(periodStart) as Array<{ topic: string; count: number }>;

  // Topics needing improvement: combine low ratings + unresolved gaps
  const lowRatedTopics = db.prepare(`
    SELECT SUBSTR(query, 1, 60) as topic, AVG(rating) as avg_rating
    FROM feedback
    WHERE timestamp > ? AND rating <= 3
    GROUP BY LOWER(SUBSTR(query, 1, 60))
    ORDER BY avg_rating ASC
    LIMIT 10
  `).all(periodStart) as Array<{ topic: string; avg_rating: number | null }>;

  const unresolvedTopics = db.prepare(`
    SELECT search_topic as topic, COUNT(*) as unresolved_gaps
    FROM gap_log
    WHERE timestamp > ? AND status != 'resolved'
    GROUP BY search_topic
    ORDER BY unresolved_gaps DESC
    LIMIT 10
  `).all(periodStart) as Array<{ topic: string; unresolved_gaps: number }>;

  // Merge and score: lower rating + more unresolved = higher priority
  const improvementMap = new Map<string, { avg_rating: number | null; unresolved_gaps: number }>();
  for (const t of lowRatedTopics) {
    improvementMap.set(t.topic, { avg_rating: t.avg_rating, unresolved_gaps: 0 });
  }
  for (const t of unresolvedTopics) {
    const existing = improvementMap.get(t.topic);
    if (existing) {
      existing.unresolved_gaps = t.unresolved_gaps;
    } else {
      improvementMap.set(t.topic, { avg_rating: null, unresolved_gaps: t.unresolved_gaps });
    }
  }

  const needsImprovement = [...improvementMap.entries()]
    .map(([topic, data]) => ({
      topic,
      avg_rating: data.avg_rating !== null ? Math.round(data.avg_rating * 100) / 100 : null,
      unresolved_gaps: data.unresolved_gaps,
      score: (data.avg_rating !== null ? (5 - data.avg_rating) * 2 : 5) + data.unresolved_gaps,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_questions: feedbackCount.count,
    total_gaps_detected: gapsDetected.count,
    gaps_resolved: gapsResolved.count,
    gaps_unresolved: gapsUnresolved.count,
    avg_user_rating: avgRating.avg !== null ? Math.round(avgRating.avg * 100) / 100 : null,
    top_topics_by_volume: topTopics,
    topics_needing_improvement: needsImprovement,
  };
}

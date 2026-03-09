// Service de détection des lacunes de connaissances et déclenchement N8N

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chatWithOllama } from "./ollama.js";
import type { OllamaMessage } from "./ollama.js";

const DB_PATH = join(process.cwd(), "data", "gap_log.db");

let db: Database.Database;

// Initialise la base SQLite pour le suivi des lacunes
export function initGapDB(): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      original_query TEXT NOT NULL,
      search_topic TEXT,
      reason TEXT,
      was_triggered INTEGER NOT NULL DEFAULT 0,
      gemma_response TEXT,
      status TEXT NOT NULL DEFAULT 'detected'
    )
  `);
}

interface ConfidenceResult {
  confident: boolean;
  reason: string;
  search_topic: string;
}

// Appel secondaire à Ollama pour évaluer la confiance de la réponse
export async function checkConfidence(
  originalQuestion: string,
  gemmaResponse: string,
  model?: string
): Promise<ConfidenceResult> {
  const prompt = `Analyze this Q&A exchange. Did the assistant actually answer the question with specific, confident information? Or did it hedge, say it doesn't know, provide only vague/generic information, or fail to address the question?

Question: ${originalQuestion}
Answer: ${gemmaResponse}

Respond with ONLY a JSON object, no other text:
{"confident": true/false, "reason": "brief explanation", "search_topic": "2-5 word search query if not confident"}`;

  try {
    const messages: OllamaMessage[] = [
      { role: "user", content: prompt },
    ];
    const response = await chatWithOllama(messages, model, { temperature: 0.1 });

    // Extraire le JSON de la réponse
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      return { confident: true, reason: "Could not parse confidence check", search_topic: "" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      confident: Boolean(parsed.confident),
      reason: String(parsed.reason ?? ""),
      search_topic: String(parsed.search_topic ?? ""),
    };
  } catch {
    // Par défaut confident=true pour éviter les faux déclenchements
    return { confident: true, reason: "Confidence check failed", search_topic: "" };
  }
}

// Vérifie si un sujet similaire a été déclenché dans les 2 dernières heures
function isOnCooldown(searchTopic: string): boolean {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM gap_log
     WHERE search_topic = ? AND was_triggered = 1 AND timestamp > ?`
  ).get(searchTopic, twoHoursAgo) as { count: number };
  return row.count > 0;
}

// Enregistre une détection de lacune dans la base
export function logGap(
  originalQuery: string,
  searchTopic: string,
  reason: string,
  gemmaResponse: string,
  wasTriggered: boolean
): void {
  db.prepare(
    `INSERT INTO gap_log (timestamp, original_query, search_topic, reason, was_triggered, gemma_response, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    originalQuery,
    searchTopic,
    reason,
    wasTriggered ? 1 : 0,
    gemmaResponse,
    wasTriggered ? "triggered" : "skipped"
  );
}

// Envoie le webhook N8N de manière asynchrone
export async function triggerWebhook(
  originalQuery: string,
  searchTopic: string,
  gemmaResponse: string,
  reason: string
): Promise<void> {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[Gap Detector] N8N_WEBHOOK_URL not set, skipping webhook");
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        original_query: originalQuery,
        search_topic: searchTopic,
        timestamp: new Date().toISOString(),
        gemma_response: gemmaResponse,
        reason,
      }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Gap Detector] Webhook triggered for topic: "${searchTopic}"`);
  } catch (err) {
    console.error("[Gap Detector] Webhook failed:", err);
  }
}

// Orchestre la détection : confidence check → cooldown → log → webhook
export async function handleGapDetection(
  originalQuery: string,
  gemmaResponse: string,
  model?: string
): Promise<boolean> {
  const result = await checkConfidence(originalQuery, gemmaResponse, model);

  if (result.confident) {
    return false;
  }

  const onCooldown = isOnCooldown(result.search_topic);
  logGap(originalQuery, result.search_topic, result.reason, gemmaResponse, !onCooldown);

  if (!onCooldown) {
    // Webhook asynchrone — ne bloque pas la réponse
    triggerWebhook(originalQuery, result.search_topic, gemmaResponse, result.reason)
      .catch((err: unknown) => console.error("[Gap Detector] Async webhook error:", err));
  } else {
    console.log(`[Gap Detector] Topic "${result.search_topic}" on cooldown, skipped webhook`);
  }

  return true;
}

// --- Fonctions de requête pour l'API ---

export interface GapLogEntry {
  id: number;
  timestamp: string;
  original_query: string;
  search_topic: string;
  reason: string;
  was_triggered: boolean;
  gemma_response: string;
  status: string;
}

export function getRecentGaps(limit: number = 50): GapLogEntry[] {
  const rows = db.prepare(
    `SELECT * FROM gap_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as Array<{
    id: number;
    timestamp: string;
    original_query: string;
    search_topic: string;
    reason: string;
    was_triggered: number;
    gemma_response: string;
    status: string;
  }>;

  return rows.map((r) => ({
    ...r,
    was_triggered: r.was_triggered === 1,
  }));
}

export interface GapStats {
  total_detected: number;
  total_triggered: number;
  total_resolved: number;
  most_common_topics: Array<{ topic: string; count: number }>;
}

export function getGapStats(): GapStats {
  const total = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log"
  ).get() as { count: number };

  const triggered = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE was_triggered = 1"
  ).get() as { count: number };

  const resolved = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE status = 'resolved'"
  ).get() as { count: number };

  const topics = db.prepare(
    `SELECT search_topic as topic, COUNT(*) as count
     FROM gap_log
     WHERE search_topic IS NOT NULL AND search_topic != ''
     GROUP BY search_topic
     ORDER BY count DESC
     LIMIT 10`
  ).all() as Array<{ topic: string; count: number }>;

  return {
    total_detected: total.count,
    total_triggered: triggered.count,
    total_resolved: resolved.count,
    most_common_topics: topics,
  };
}

#!/usr/bin/env -S node --import tsx
// Acceptance harness for the System One scorer.
//
// Stage 1 (--backfill): runs the existing 27B checkConfidence() over gaps that
// have a gemma_response but no verdict, writing the result to a local baseline
// file. Slow and sequential, and it competes with live chat -- run it when
// nobody is using the app.
//
// Stage 2 (default): replays those gaps through /api/decide and reports
// agreement, the two directions of disagreement, and the probability
// distribution.
//
// The baseline is the 27B's opinion, not ground truth. This measures whether a
// 4B can stand in for the 27B on this task; it does not measure whether the
// 27B was right -- and the 27B's own judgment had a known failure mode (a
// parse miss returned confident: true, silently closing gaps). Agreement with
// this baseline is not the same thing as either model being correct.
//
// Usage:
//   npx tsx scripts/replay-gap-decisions.ts --backfill [--limit 63]
//   npx tsx scripts/replay-gap-decisions.ts [--limit 63]

import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfidence } from "../src/services/gap-detector.js";
import { buildReplayReport } from "../src/services/replay-report.js";
import type { ReplayRow } from "../src/services/replay-report.js";
import type { Verdict } from "../src/services/decide-config.js";

const BASELINE_PATH = join(process.cwd(), "data", "run", "gap-baseline.json");
const DB_PATH = join(process.cwd(), "data", "gap_log.db");

interface GapRow {
  id: number;
  original_query: string;
  gemma_response: string;
  status: string;
}

interface Baseline {
  [gapId: string]: "resolved" | "unresolved";
}

function gapsWithAnswers(limit: number): GapRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, original_query, gemma_response, status
           FROM gap_log
          WHERE gemma_response IS NOT NULL AND gemma_response != ''
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(limit) as GapRow[];
  } finally {
    db.close();
  }
}

async function backfill(limit: number): Promise<void> {
  const rows = gapsWithAnswers(limit);
  const baseline: Baseline = {};
  console.log(`[backfill] labelling ${rows.length} gaps with the 27B -- this is slow and uses the shared model`);
  for (const [i, row] of rows.entries()) {
    // A gap that already carries a verdict keeps it; the rest are labelled.
    if (row.status === "resolved" || row.status === "unresolved") {
      baseline[String(row.id)] = row.status;
    } else {
      const confidence = await checkConfidence(row.original_query, row.gemma_response);
      baseline[String(row.id)] = confidence.confident ? "resolved" : "unresolved";
    }
    console.log(`[backfill] ${i + 1}/${rows.length} gap ${row.id} -> ${baseline[String(row.id)]}`);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`[backfill] wrote ${BASELINE_PATH}`);
}

async function replay(limit: number): Promise<void> {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const token = readFileSync(join(process.cwd(), "data", "run", "api-token"), "utf8").trim();
  const rows: ReplayRow[] = [];

  for (const row of gapsWithAnswers(limit)) {
    const label = baseline[String(row.id)];
    if (label === undefined) continue;

    const resp = await fetch("http://127.0.0.1:3000/api/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        state: `Question: ${row.original_query}\nAnswer: ${row.gemma_response}`,
        question: {
          id: "resolved",
          instructions:
            "Did the assistant answer the question with specific, confident information, rather than hedging, saying it does not know, or giving only vague generic information?",
          whenTrue: "The answer is specific and addresses the question.",
          whenFalse: "The answer hedges, is vague, or does not address the question.",
        },
      }),
    });
    if (!resp.ok) {
      console.error(`gap ${row.id}: /api/decide returned ${resp.status}`);
      continue;
    }
    const decision = (await resp.json()) as { verdict: Verdict; probability: number };
    rows.push({ gapId: row.id, baseline: label, verdict: decision.verdict, probability: decision.probability });
  }

  const report = buildReplayReport(rows);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nagreement (of ${report.total - report.review} committed): ${(report.agreementRate * 100).toFixed(1)}%`);
  console.log(`false resolved (closes an open gap): ${report.falseResolved}`);
  console.log(`false unresolved (burns a retry):    ${report.falseUnresolved}`);
  console.log(`parked for review:                   ${report.review} of ${report.total}`);
  console.log(`\nIf most rows sit in the 0.5-0.8 buckets, the thresholds are deciding, not the model.`);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg === -1 ? 100 : Number(args[limitArg + 1] ?? 100);
await (args.includes("--backfill") ? backfill(limit) : replay(limit));

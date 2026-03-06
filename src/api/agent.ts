// Routes API for the news agent

import { Router } from "express";
import type { Request, Response } from "express";
import { runNewsAgent, getAgentTopics } from "../services/news-agent.js";

const router = Router();

let lastRunResult: { newArticles: number; topics: number; timestamp: string } | null = null;
let isRunning = false;

// POST /api/agent/run - Trigger a manual news scrub
router.post("/run", async (_req: Request, res: Response): Promise<void> => {
  if (isRunning) {
    res.status(409).json({ error: "Agent is already running" });
    return;
  }

  isRunning = true;
  try {
    const result = await runNewsAgent();
    lastRunResult = { ...result, timestamp: new Date().toISOString() };
    res.json({ message: `Scrub complete: ${result.newArticles} new articles from ${result.topics} topics`, ...lastRunResult });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: msg });
  } finally {
    isRunning = false;
  }
});

// GET /api/agent/status - Get agent status
router.get("/status", (_req: Request, res: Response): void => {
  res.json({
    isRunning,
    lastRun: lastRunResult,
    topics: getAgentTopics(),
    schedule: "Every 24 hours",
  });
});

export default router;

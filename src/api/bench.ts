// Routes for benchmark mode

import { Router } from "express";
import type { Request, Response } from "express";
import { getRunningJobs, isBenchmarkActive, setBenchmarkActive } from "../services/bench-mode.js";

const router = Router();

function benchStatus(): { active: boolean; runningJobs: string[] } {
  return { active: isBenchmarkActive(), runningJobs: getRunningJobs() };
}

// POST /api/bench/start - Pause background LLM jobs
router.post("/start", (_req: Request, res: Response): void => {
  setBenchmarkActive(true);
  res.json(benchStatus());
});

// POST /api/bench/stop - Resume background LLM jobs
router.post("/stop", (_req: Request, res: Response): void => {
  setBenchmarkActive(false);
  res.json(benchStatus());
});

// GET /api/bench/status - Benchmark flag and jobs still running
router.get("/status", (_req: Request, res: Response): void => {
  res.json(benchStatus());
});

export default router;

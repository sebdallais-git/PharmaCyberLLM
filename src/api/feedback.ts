// Feedback API routes

import { Router } from "express";
import type { Request, Response } from "express";
import {
  addFeedback,
  getFeedbackStats,
  getLowRatedFeedback,
  getWeeklyDigest,
} from "../services/feedback-store.js";
import { getResponseEntry } from "../services/response-cache.js";

const router = Router();

// POST /api/feedback - Submit feedback for a response
router.post("/", (req: Request, res: Response): void => {
  const { query, response, rating, comment, response_id } = req.body as {
    query?: string;
    response?: string;
    rating?: number;
    comment?: string;
    response_id?: string;
  };

  if (!rating || rating < 1 || rating > 5) {
    res.status(400).json({ error: "rating is required (1-5)" });
    return;
  }

  // Look up response metadata from cache if response_id is provided
  let feedbackQuery = query ?? "";
  let feedbackResponse = response ?? "";
  let chunkIds: string[] = [];
  let hadRagContext = false;

  if (response_id) {
    const cached = getResponseEntry(response_id);
    if (cached) {
      feedbackQuery = feedbackQuery || cached.query;
      feedbackResponse = feedbackResponse || cached.response;
      chunkIds = cached.chunkIds;
      hadRagContext = cached.hadRagContext;
    }
  }

  if (!feedbackQuery || !feedbackResponse) {
    res.status(400).json({ error: "query and response are required (or provide a valid response_id)" });
    return;
  }

  try {
    const id = addFeedback({
      query: feedbackQuery,
      response: feedbackResponse,
      rating,
      comment,
      hadRagContext,
      chunkIds,
      responseId: response_id,
    });

    res.json({ message: "Feedback recorded", id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/feedback/stats - Feedback analytics
router.get("/stats", (_req: Request, res: Response): void => {
  try {
    res.json(getFeedbackStats());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/feedback/low-rated - Responses rated <= 2
router.get("/low-rated", (_req: Request, res: Response): void => {
  try {
    res.json({ entries: getLowRatedFeedback() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/feedback/weekly-digest - 7-day summary
router.get("/weekly-digest", (_req: Request, res: Response): void => {
  try {
    res.json(getWeeklyDigest());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

export default router;

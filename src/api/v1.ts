// OpenAI-compatible endpoints so agents use PharmaLLM's active LLM stack

import { Router } from "express";
import type { Request, Response } from "express";
import { getLlmClient } from "../services/llm-client.js";
import { isBenchmarkActive, trackJob } from "../services/bench-mode.js";
import { forwardChatCompletion, modelList, openAiError } from "../services/model-gateway.js";

const router = Router();

// GET /v1/models - The active stack's chat model (503 when the stack is down)
router.get("/models", async (_req: Request, res: Response): Promise<void> => {
  const llm = getLlmClient();
  try {
    await llm.listModels();
    res.json(modelList(llm.stack));
  } catch (err) {
    res.status(503).json(openAiError(err instanceof Error ? err.message : "LLM stack unavailable", "service_unavailable"));
  }
});

// POST /v1/chat/completions - Forwarded to the active stack (tools and streaming supported)
router.post("/chat/completions", async (req: Request, res: Response): Promise<void> => {
  const llm = getLlmClient();
  await forwardChatCompletion(req.body, res, {
    stack: llm.stack,
    fetchImpl: fetch,
    isBenchmarkActive: () => isBenchmarkActive(),
    trackJob,
  });
});

export default router;

// OpenAI-compatible endpoints so agents use PharmaITChat's active LLM stack

import { Router } from "express";
import type { Request, Response } from "express";
import { getLlmClient } from "../services/llm-client.js";
import type { LlmClient } from "../services/llm-client.js";
import { isBenchmarkActive, trackJob } from "../services/bench-mode.js";
import { forwardChatCompletion, gatewayFetch, modelList, openAiError } from "../services/model-gateway.js";
import type { GatewayDeps } from "../services/model-gateway.js";

export interface V1Deps extends Omit<GatewayDeps, "stack"> {
  getLlm: () => Pick<LlmClient, "stack" | "listModels">;
}

const defaultDeps: V1Deps = {
  getLlm: () => getLlmClient(),
  fetchImpl: gatewayFetch,
  isBenchmarkActive: () => isBenchmarkActive(),
  trackJob,
};

export function createV1Router(deps: V1Deps = defaultDeps): Router {
  const router = Router();

  // GET /v1/models - The active stack's chat model (503 when the stack is down)
  router.get("/models", async (_req: Request, res: Response): Promise<void> => {
    const llm = deps.getLlm();
    try {
      await llm.listModels();
      res.json(modelList(llm.stack));
    } catch (err) {
      res.status(503).json(openAiError(err instanceof Error ? err.message : "LLM stack unavailable", "service_unavailable"));
    }
  });

  // POST /v1/chat/completions - Forwarded to the active stack (tools and streaming supported)
  router.post("/chat/completions", async (req: Request, res: Response): Promise<void> => {
    await forwardChatCompletion(req.body, res, {
      stack: deps.getLlm().stack,
      fetchImpl: deps.fetchImpl,
      isBenchmarkActive: deps.isBenchmarkActive,
      trackJob: deps.trackJob,
    });
  });

  return router;
}

export default createV1Router();

// Completion endpoint for external workflows (n8n), so they use the active LLM stack instead of calling Ollama directly

import { Router } from "express";
import type { Request, Response } from "express";
import { getLlmClient, StackUnavailableError } from "../services/llm-client.js";
import { isBenchmarkActive, trackJob } from "../services/bench-mode.js";

const router = Router();

export interface CompletionRequest {
  prompt: string;
  temperature?: number;
}

export function parseCompletionRequest(body: unknown): CompletionRequest | { error: string } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.prompt !== "string" || !fields.prompt.trim()) {
    return { error: "The 'prompt' field is required" };
  }
  return typeof fields.temperature === "number"
    ? { prompt: fields.prompt, temperature: fields.temperature }
    : { prompt: fields.prompt };
}

// POST /api/llm/complete - Ollama /api/generate-shaped completion on the active stack
router.post("/complete", async (req: Request, res: Response): Promise<void> => {
  const parsed = parseCompletionRequest(req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (isBenchmarkActive()) {
    res.status(503).json({ error: "Benchmark in progress — try again later" });
    return;
  }

  const llm = getLlmClient();
  try {
    const response = await trackJob("n8n-completion", () =>
      llm.chat([{ role: "user", content: parsed.prompt }], { temperature: parsed.temperature })
    );
    res.json({ response, done: true, stack: llm.stack.name, model: llm.stack.chatModel });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Completion failed";
    res.status(err instanceof StackUnavailableError ? 503 : 500).json({ error: message });
  }
});

export default router;

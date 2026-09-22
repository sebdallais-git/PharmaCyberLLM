// Decision endpoint for external workflows (n8n), so they reach the scorer
// through the app instead of calling it directly -- the same arrangement as
// /api/llm/complete. The scorer's address and key stay here; n8n sends only
// the app's API token.
//
// This file does NOT add /api/decide to src/api/auth.ts's BROWSER_ROUTES.
// That list is an allowlist of UNPROTECTED routes; absence from it already
// means protected, which is what a route holding another service's key needs.

import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, ScorerUnavailableError } from "../services/decide.js";
import type { Decision, DecisionQuestion } from "../services/decide.js";
import { loadDecideConfig } from "../services/decide-config.js";

export interface DecideRequest {
  question: DecisionQuestion;
  state: string;
}

export function parseDecideRequest(body: unknown): DecideRequest | { error: string } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.state !== "string" || fields.state.trim() === "") {
    return { error: "The 'state' field is required" };
  }
  const q = typeof fields.question === "object" && fields.question !== null
    ? (fields.question as Record<string, unknown>)
    : {};
  for (const key of ["id", "instructions", "whenTrue", "whenFalse"]) {
    if (typeof q[key] !== "string" || (q[key] as string).trim() === "") {
      return { error: `question.${key} is required` };
    }
  }
  return {
    state: fields.state,
    question: {
      id: q.id as string,
      instructions: q.instructions as string,
      whenTrue: q.whenTrue as string,
      whenFalse: q.whenFalse as string,
    },
  };
}

export interface DecideRouterDeps {
  decide(question: DecisionQuestion, state: string): Promise<Decision>;
}

export function createDecideRouter(deps: DecideRouterDeps): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const parsed = parseDecideRequest(req.body);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      const decision = await deps.decide(parsed.question, parsed.state);
      res.json(decision);
    } catch (err) {
      // 503 for an outage so n8n retries; the message names the address, never
      // the key (see decide.ts).
      const unavailable = err instanceof ScorerUnavailableError;
      res.status(unavailable ? 503 : 500).json({
        error: err instanceof Error ? err.message : "Decision failed",
      });
    }
  });

  return router;
}

// Reads data/run/jev-token if present. Mode 600, never .env, never an argument.
// Exported because src/api/knowledge.ts (Task 5) reuses it rather than
// re-deriving the token path.
export function readScorerKey(): string | null {
  const path = join(process.env.PHARMALLM_RUN_DIR ?? join(process.cwd(), "data", "run"), "jev-token");
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

// Lazily built so that importing this module opens no file and reads no
// config: every test imports it for parseDecideRequest or createDecideRouter.
let live: DecideRouterDeps | null = null;
function liveDeps(): DecideRouterDeps {
  return (live ??= {
    decide: (question, state) =>
      decide(question, state, { config: loadDecideConfig(), apiKey: readScorerKey(), fetchImpl: fetch }),
  });
}

export default createDecideRouter({
  decide: (question, state) => liveDeps().decide(question, state),
});

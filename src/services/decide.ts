// Client for the open-jev System One scorer.
//
// open-jev answers POST /v1/systemone with three question types; a yes/no is a
// "noul", whose answer is the probability of yes. That probability maps onto a
// verdict by threshold, with no parsing step -- which is the point of this
// service. The judgment it replaces (gap-detector.ts checkConfidence) pulled
// JSON out of free text with a regex and defaulted to "confident" when the
// regex missed, silently marking gaps resolved.
//
// R1: every failure throws. There is deliberately no fallback verdict. A
// decision this service cannot make is the caller's problem to report, not
// something to guess at, because both guesses are wrong in an expensive way:
// a false "resolved" closes an open gap, a false "unresolved" burns a retry
// and re-runs the whole ingest.

import type { DecideConfig, Verdict } from "./decide-config.js";

export interface DecisionQuestion {
  id: string;
  instructions: string;
  whenTrue: string;
  whenFalse: string;
}

export interface Decision {
  verdict: Verdict;
  probability: number;
}

export interface DecideDeps {
  config: DecideConfig;
  apiKey: string | null;
  fetchImpl: typeof fetch;
}

export class ScorerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScorerUnavailableError";
  }
}

function readNoul(body: unknown, questionId: string): number {
  if (typeof body !== "object" || body === null) {
    throw new Error("decide: scorer returned a non-object body");
  }
  const answers = (body as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null) {
    throw new Error("decide: scorer response has no answers");
  }
  const answer = (answers as Record<string, unknown>)[questionId];
  if (typeof answer !== "object" || answer === null) {
    throw new Error(`decide: scorer response has no answer for "${questionId}"`);
  }
  const noul = (answer as Record<string, unknown>).noul;
  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    throw new Error(`decide: scorer returned an invalid noul for "${questionId}": ${JSON.stringify(noul)}`);
  }
  return noul;
}

export function verdictFor(noul: number, thresholds: DecideConfig["thresholds"]): Verdict {
  if (noul >= thresholds.resolved) return "resolved";
  if (noul < thresholds.unresolved) return "unresolved";
  return "review";
}

export async function decide(
  question: DecisionQuestion,
  state: string,
  deps: DecideDeps,
): Promise<Decision> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiKey !== null) headers.Authorization = `Bearer ${deps.apiKey}`;

  let resp: Response;
  try {
    resp = await deps.fetchImpl(`${deps.config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        state,
        model: deps.config.model,
        questions: {
          [question.id]: {
            type: "noul",
            instructions: question.instructions,
            criteria: { true: question.whenTrue, false: question.whenFalse },
          },
        },
      }),
      signal: AbortSignal.timeout(deps.config.timeoutMs),
    });
  } catch (err) {
    // The message never carries the key, only the address.
    throw new ScorerUnavailableError(
      `decide: scorer at ${deps.config.baseUrl} is unreachable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!resp.ok) {
    throw new ScorerUnavailableError(`decide: scorer returned ${resp.status}`);
  }

  const noul = readNoul(await resp.json(), question.id);
  return { verdict: verdictFor(noul, deps.config.thresholds), probability: noul };
}

import { describe, expect, it } from "@jest/globals";
import { decide, ScorerUnavailableError } from "../src/services/decide.js";
import type { DecideDeps, DecisionQuestion } from "../src/services/decide.js";

const question: DecisionQuestion = {
  id: "resolved",
  instructions: "Did the answer address the question with specific information?",
  whenTrue: "The answer is specific and addresses the question.",
  whenFalse: "The answer hedges, is vague, or says it does not know.",
};

function depsReturning(noul: number, seen?: { body?: unknown; url?: string; auth?: string | null }): DecideDeps {
  return {
    config: {
      baseUrl: "http://127.0.0.1:8000",
      model: "jev-latest",
      timeoutMs: 15000,
      thresholds: { resolved: 0.85, unresolved: 0.5 },
    },
    apiKey: "secret-key",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (seen) {
        seen.url = String(url);
        seen.body = JSON.parse(String(init?.body ?? "{}"));
        seen.auth = new Headers(init?.headers).get("authorization");
      }
      return new Response(JSON.stringify({ answers: { resolved: { noul } } }), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

describe("decide", () => {
  it("sends a noul question to /v1/systemone with the scorer key", async () => {
    const seen: { body?: unknown; url?: string; auth?: string | null } = {};

    await decide(question, "Q: x\nA: y", depsReturning(0.9, seen));

    expect(seen.url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(seen.auth).toBe("Bearer secret-key");
    expect(seen.body).toEqual({
      state: "Q: x\nA: y",
      model: "jev-latest",
      questions: {
        resolved: {
          type: "noul",
          instructions: question.instructions,
          criteria: { true: question.whenTrue, false: question.whenFalse },
        },
      },
    });
  });

  // Both edges are named explicitly: an off-by-one on either boundary silently
  // moves gaps between "closed" and "spend a retry".
  it.each([
    [0.95, "resolved"],
    [0.85, "resolved"],
    [0.8499, "review"],
    [0.6, "review"],
    [0.5, "review"],
    [0.4999, "unresolved"],
    [0.0, "unresolved"],
  ])("maps noul %s to %s", async (noul: number, expected: string) => {
    const decision = await decide(question, "state", depsReturning(noul));

    expect(decision.verdict).toBe(expected);
    expect(decision.probability).toBe(noul);
  });

  // The bug this service replaces: checkConfidence() returned
  // { confident: true } whenever it could not parse the model, so an
  // unparseable judgment silently marked a gap resolved. A scorer that cannot
  // answer must stop the decision, never supply one.
  it("throws rather than returning a verdict when the scorer is unreachable", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it("throws on a non-ok response", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it.each([
    ["missing answers", {}],
    ["missing the question id", { answers: {} }],
    ["a non-numeric noul", { answers: { resolved: { noul: "yes" } } }],
    ["a noul outside 0..1", { answers: { resolved: { noul: 1.4 } } }],
  ])("throws on %s", async (_label: string, body: unknown) => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toThrow();
  });

  it("omits the Authorization header when no key is configured", async () => {
    const seen: { auth?: string | null } = {};
    const deps = depsReturning(0.9, seen);
    deps.apiKey = null;

    await decide(question, "state", deps);

    expect(seen.auth).toBeNull();
  });
});

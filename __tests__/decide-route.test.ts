import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDecideRouter, parseDecideRequest } from "../src/api/decide.js";
import { ScorerUnavailableError } from "../src/services/decide.js";
import { isProtectedRequest } from "../src/api/auth.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const good = {
  state: "Q: what is x?\nA: x is y.",
  question: { id: "resolved", instructions: "Did it answer?", whenTrue: "yes", whenFalse: "no" },
};

function startApp(decideImpl: DecideImpl): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/decide", createDecideRouter({ decide: decideImpl }));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

type DecideImpl = Parameters<typeof createDecideRouter>[0]["decide"];

describe("parseDecideRequest", () => {
  it("accepts a complete request", () => {
    const parsed = parseDecideRequest(good);

    expect("error" in parsed).toBe(false);
  });

  it.each([
    ["no state", { ...good, state: undefined }],
    ["an empty state", { ...good, state: "   " }],
    ["no question", { state: "x" }],
    ["a question with no id", { ...good, question: { ...good.question, id: "" } }],
    ["a non-object body", null],
  ])("rejects %s", (_label: string, body: unknown) => {
    const parsed = parseDecideRequest(body);

    expect("error" in parsed).toBe(true);
  });
});

describe("POST /api/decide", () => {
  it("returns the verdict and probability", async () => {
    const url = await startApp(async () => ({ verdict: "resolved", probability: 0.92 }));

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: "resolved", probability: 0.92 });
  });

  it("returns 400 for an invalid body", async () => {
    const url = await startApp(async () => ({ verdict: "resolved", probability: 1 }));

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "" }),
    });

    expect(res.status).toBe(400);
  });

  // 503, not 500: the scorer being down is a dependency outage, and the caller
  // (n8n) should treat it as retryable rather than as a bad request.
  it("returns 503 when the scorer is unavailable", async () => {
    const url = await startApp(async () => {
      throw new ScorerUnavailableError("decide: scorer at http://127.0.0.1:8000 is unreachable");
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(503);
  });

  it("never echoes the scorer key in an error body", async () => {
    const url = await startApp(async () => {
      throw new ScorerUnavailableError("decide: scorer returned 401");
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(JSON.stringify(await res.json())).not.toMatch(/bearer|token|key/i);
  });
});

// BROWSER_ROUTES in src/api/auth.ts is an allowlist of UNPROTECTED routes.
// /api/decide must stay out of it: it fronts a scorer whose key the app holds.
// This test fails if someone later "fixes" that list.
describe("auth", () => {
  it("keeps /api/decide behind the API token", () => {
    expect(isProtectedRequest("POST", "/api/decide")).toBe(true);
  });
});

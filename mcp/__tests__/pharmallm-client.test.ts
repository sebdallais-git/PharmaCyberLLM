import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createPharmaLLMClient, PharmaLLMError } from "../src/pharmallm-client.js";
import { sendJson, sendSse, startFakePharmaLLM } from "./helpers/fake-pharmallm.js";
import type { FakePharmaLLM } from "./helpers/fake-pharmallm.js";

let pharma: FakePharmaLLM;

beforeEach(async () => {
  pharma = await startFakePharmaLLM();
});

afterEach(async () => {
  await pharma.close();
});

describe("get and post", () => {
  it("sends the API token and parses JSON", async () => {
    pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy" }));
    const client = createPharmaLLMClient(pharma.url, "app-secret");

    await expect(client.get("/api/health")).resolves.toEqual({ status: "healthy" });
    expect(pharma.requests[0].headers.authorization).toBe("Bearer app-secret");
  });

  it("sends no Authorization header without a token and posts JSON", async () => {
    pharma.on("POST", "/api/knowledge/search", (_req, res) => sendJson(res, 200, { results: [] }));
    const client = createPharmaLLMClient(pharma.url, null);

    await client.post("/api/knowledge/search", { query: "Dell", topK: 5 });
    expect(pharma.requests[0].headers.authorization).toBeUndefined();
    expect(pharma.requests[0].body).toEqual({ query: "Dell", topK: 5 });
  });

  it("explains a rejected token", async () => {
    pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 401, { error: "Unauthorized" }));
    const client = createPharmaLLMClient(pharma.url, "wrong");

    await expect(client.get("/api/health")).rejects.toThrow(
      "PharmaLLM rejected the API token — check PHARMALLM_API_TOKEN"
    );
  });

  it("includes status and PharmaLLM's error message", async () => {
    pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 503, { error: "Search refused: index incomplete" })
    );
    const client = createPharmaLLMClient(pharma.url, null);

    const error = await client.post("/api/knowledge/search", { query: "x" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PharmaLLMError);
    expect((error as PharmaLLMError).status).toBe(503);
    expect((error as PharmaLLMError).message).toBe(
      "PharmaLLM /api/knowledge/search failed (503): Search refused: index incomplete"
    );
  });

  it("reports an unreachable PharmaLLM", async () => {
    const client = createPharmaLLMClient("http://127.0.0.1:9", null);
    await expect(client.get("/api/health")).rejects.toThrow("PharmaLLM not reachable at http://127.0.0.1:9");
  });

  it("times out a slow request", async () => {
    pharma.on("GET", "/api/health", () => {
      // never answers
    });
    const client = createPharmaLLMClient(pharma.url, null);
    await expect(client.get("/api/health", 50)).rejects.toThrow("PharmaLLM did not answer within 0.05 s");
  });
});

describe("ask", () => {
  it("collects the answer, sources and done fields from the chat stream", async () => {
    pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [
        { reasoning: "Searching knowledge base...", sources: [] },
        { reasoning: "Found 2 chunks", sources: ["vendor-dell-cyber-recovery.md", "pharma-basics.md"] },
        { reasoning: "Found 1 web result", sources: ["vendor-dell-cyber-recovery.md"] },
        { token: "Dell " },
        { token: "isolates backups." },
        { done: true, stack: "ollama", response_id: "r-1", timings: { totalMs: 1234 } },
      ])
    );
    const client = createPharmaLLMClient(pharma.url, null);

    await expect(client.ask("How does Dell protect backups?", false, 5000)).resolves.toEqual({
      answer: "Dell isolates backups.",
      sources: ["vendor-dell-cyber-recovery.md", "pharma-basics.md"],
      stack: "ollama",
      response_id: "r-1",
      timings: { totalMs: 1234 },
    });
    expect(pharma.requests[0].body).toEqual({ message: "How does Dell protect backups?", webSearch: false });
  });

  it("turns a stream error event into a PharmaLLMError", async () => {
    pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [{ error: "OLLAMA stack not reachable at http://localhost:11434/v1/chat/completions" }])
    );
    const client = createPharmaLLMClient(pharma.url, null);

    await expect(client.ask("hi", false, 5000)).rejects.toThrow("OLLAMA stack not reachable");
  });

  it("fails when the stream ends without an answer", async () => {
    pharma.on("POST", "/api/chat", (_req, res) => sendSse(res, [{ token: "partial" }]));
    const client = createPharmaLLMClient(pharma.url, null);

    await expect(client.ask("hi", false, 5000)).rejects.toThrow("PharmaLLM chat stream ended without an answer");
  });
});

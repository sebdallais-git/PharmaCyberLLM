import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { sendJson, sendSse } from "./helpers/fake-pharmallm.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ pharmallmToken: "app-secret" });
});

afterEach(async () => {
  await harness.close();
});

describe("search_knowledge", () => {
  it("maps top_k and forwards the API token", async () => {
    harness.pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 200, { results: [{ source: "vendor-dell-cyber-recovery.md", content: "Air-gapped vault" }] })
    );

    const result = await harness.client.callTool({ name: "search_knowledge", arguments: { query: "Dell vault", top_k: 3 } });

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(toolText(result))).toEqual({
      results: [{ source: "vendor-dell-cyber-recovery.md", content: "Air-gapped vault" }],
    });
    expect(harness.pharma.requests[0].body).toEqual({ query: "Dell vault", topK: 3 });
    expect(harness.pharma.requests[0].headers.authorization).toBe("Bearer app-secret");
  });

  it("turns PharmaLLM errors into tool errors", async () => {
    harness.pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 503, { error: "Search refused: index incomplete" })
    );

    const result = await harness.client.callTool({ name: "search_knowledge", arguments: { query: "x" } });

    expect(isToolError(result)).toBe(true);
    expect(toolText(result)).toBe("PharmaLLM /api/knowledge/search failed (503): Search refused: index incomplete");
    expect(harness.pharma.requests[0].body).toEqual({ query: "x", topK: 5 });
  });
});

describe("ask_pharmallm", () => {
  it("returns the collected answer", async () => {
    harness.pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [
        { reasoning: "Found 1 chunk", sources: ["pharma-regulation.md"] },
        { token: "21 CFR Part 11 covers electronic records." },
        { done: true, stack: "mlx", response_id: "r-9", timings: { totalMs: 90000 } },
      ])
    );

    const result = await harness.client.callTool({ name: "ask_pharmallm", arguments: { question: "What is Part 11?" } });

    expect(JSON.parse(toolText(result))).toEqual({
      answer: "21 CFR Part 11 covers electronic records.",
      sources: ["pharma-regulation.md"],
      stack: "mlx",
      response_id: "r-9",
      timings: { totalMs: 90000 },
    });
    expect(harness.pharma.requests[0].body).toEqual({ message: "What is Part 11?", webSearch: false });
  });
});

describe("add_knowledge", () => {
  it("adds text through ingest-text", async () => {
    harness.pharma.on("POST", "/api/knowledge/ingest-text", (_req, res) => sendJson(res, 200, { added: 2 }));

    const result = await harness.client.callTool({
      name: "add_knowledge",
      arguments: { text: "Novartis opened a new SOC in Basel.", source: "analyst-note" },
    });

    expect(JSON.parse(toolText(result))).toEqual({ added: 2 });
    expect(harness.pharma.requests[0].body).toEqual({ text: "Novartis opened a new SOC in Basel.", source: "analyst-note" });
  });

  it("adds a URL through add", async () => {
    harness.pharma.on("POST", "/api/knowledge/add", (_req, res) => sendJson(res, 200, { added: 4 }));

    await harness.client.callTool({ name: "add_knowledge", arguments: { url: "https://example.com/report" } });

    expect(harness.pharma.requests[0].path).toBe("/api/knowledge/add");
    expect(harness.pharma.requests[0].body).toEqual({ url: "https://example.com/report" });
  });

  it("rejects missing or conflicting input without calling PharmaLLM", async () => {
    const neither = await harness.client.callTool({ name: "add_knowledge", arguments: { text: "no source" } });
    const both = await harness.client.callTool({
      name: "add_knowledge",
      arguments: { text: "t", source: "s", url: "https://example.com" },
    });

    expect(toolText(neither)).toBe("Provide text with a source name, or a url");
    expect(toolText(both)).toBe("Provide either text with a source, or a url, not both");
    expect(harness.pharma.requests).toHaveLength(0);
  });
});

describe("knowledge_status", () => {
  it("combines stats and ChromaDB status", async () => {
    harness.pharma.on("GET", "/api/knowledge/stats", (_req, res) => sendJson(res, 200, { totalChunks: 7626 }));
    harness.pharma.on("GET", "/api/knowledge/status", (_req, res) => sendJson(res, 200, { chromadb: "ok" }));

    const result = await harness.client.callTool({ name: "knowledge_status", arguments: {} });

    expect(JSON.parse(toolText(result))).toEqual({ stats: { totalChunks: 7626 }, status: { chromadb: "ok" } });
  });
});

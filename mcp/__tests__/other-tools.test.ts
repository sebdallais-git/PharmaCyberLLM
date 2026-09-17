import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NEWS_AGENT_TIMEOUT_MS } from "../src/tools/operations.js";
import { sendJson } from "./helpers/fake-pharmallm.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return harness.client.callTool({ name, arguments: args });
}

describe("tool list", () => {
  it("exposes exactly the 16 PharmaLLM tools", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_knowledge",
      "ask_pharmallm",
      "dashboard_metrics",
      "feedback_report",
      "graph_search",
      "graph_stats",
      "knowledge_status",
      "list_knowledge_gaps",
      "news_agent_status",
      "record_feedback",
      "reindex_status",
      "resolve_knowledge_gap",
      "run_news_agent",
      "search_knowledge",
      "start_reindex",
      "system_health",
    ]);
  });
});

describe("graph tools", () => {
  it("searches an entity by name", async () => {
    harness.pharma.on("POST", "/api/graph/search", (_req, res) => sendJson(res, 200, { results: [{ name: "LockBit" }] }));

    const result = await call("graph_search", { entity: "LockBit" });

    expect(JSON.parse(toolText(result))).toEqual({ results: [{ name: "LockBit" }] });
    expect(harness.pharma.requests[0].body).toEqual({ name: "LockBit" });
  });

  it("returns graph stats", async () => {
    harness.pharma.on("GET", "/api/graph/stats", (_req, res) => sendJson(res, 200, { nodeCount: 498 }));
    expect(JSON.parse(toolText(await call("graph_stats")))).toEqual({ nodeCount: 498 });
  });
});

describe("gap tools", () => {
  // PharmaLLM inserts new gaps as 'triggered', not 'detected' (src/services/gap-detector.ts)
  function serveGaps(): void {
    harness.pharma.on("GET", "/api/knowledge/gaps", (_req, res) =>
      sendJson(res, 200, {
        gaps: [
          { id: 1, status: "resolved" },
          { id: 2, status: "triggered" },
        ],
      })
    );
    harness.pharma.on("GET", "/api/knowledge/gaps/stats", (_req, res) => sendJson(res, 200, { total: 2 }));
  }

  it("lists gaps filtered by status with stats", async () => {
    serveGaps();

    const result = await call("list_knowledge_gaps", { status: "triggered" });

    expect(JSON.parse(toolText(result))).toEqual({ gaps: [{ id: 2, status: "triggered" }], stats: { total: 2 } });
  });

  it("returns every gap when no status is given", async () => {
    serveGaps();

    const result = await call("list_knowledge_gaps");

    expect(JSON.parse(toolText(result))).toEqual({
      gaps: [
        { id: 1, status: "resolved" },
        { id: 2, status: "triggered" },
      ],
      stats: { total: 2 },
    });
  });

  it("resolves a gap", async () => {
    harness.pharma.on("POST", "/api/knowledge/gaps/check-resolution", (_req, res) =>
      sendJson(res, 200, { resolved: true, new_response: "…", confidence_reason: "specific" })
    );

    await call("resolve_knowledge_gap", { gap_id: 7, original_query: "Who attacked Merck?" });

    expect(harness.pharma.requests[0].body).toEqual({ gap_id: 7, original_query: "Who attacked Merck?" });
  });
});

describe("operations tools", () => {
  it("maps health, metrics and news agent status to GET routes", async () => {
    harness.pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy", stack: "ollama" }));
    harness.pharma.on("GET", "/api/dashboard/metrics", (_req, res) => sendJson(res, 200, { questions_7d: 12 }));
    harness.pharma.on("GET", "/api/agent/status", (_req, res) => sendJson(res, 200, { isRunning: false }));

    expect(JSON.parse(toolText(await call("system_health")))).toEqual({ status: "healthy", stack: "ollama" });
    expect(JSON.parse(toolText(await call("dashboard_metrics")))).toEqual({ questions_7d: 12 });
    expect(JSON.parse(toolText(await call("news_agent_status")))).toEqual({ isRunning: false });
  });

  it("runs the news agent", async () => {
    harness.pharma.on("POST", "/api/agent/run", (_req, res) => sendJson(res, 200, { newArticles: 3, topics: 188 }));
    expect(JSON.parse(toolText(await call("run_news_agent")))).toEqual({ newArticles: 3, topics: 188 });
  });

  it("gives up on the news agent at 14 minutes, before Hermes' 900 s tool timeout", () => {
    expect(NEWS_AGENT_TIMEOUT_MS).toBe(840_000);
  });

  it("starts a reindex and reports its status", async () => {
    harness.pharma.on("POST", "/api/knowledge/reindex", (_req, res) => sendJson(res, 202, { job_id: "j-1", status: "running" }));
    harness.pharma.on("GET", "/api/knowledge/reindex/status", (_req, res) =>
      sendJson(res, 200, { job_id: "j-1", status: "running", progress: { raw_documents_done: 64, raw_documents_total: 7023 } })
    );

    expect(JSON.parse(toolText(await call("start_reindex")))).toEqual({ job_id: "j-1", status: "running" });
    expect(JSON.parse(toolText(await call("reindex_status")))).toMatchObject({ status: "running" });
  });

  it("surfaces a 409 when a reindex is already running", async () => {
    harness.pharma.on("POST", "/api/knowledge/reindex", (_req, res) => sendJson(res, 409, { error: "A reindex is already running" }));

    const result = await call("start_reindex");

    expect(isToolError(result)).toBe(true);
    expect(toolText(result)).toBe("PharmaLLM /api/knowledge/reindex failed (409): A reindex is already running");
  });
});

describe("feedback tools", () => {
  it("records feedback", async () => {
    harness.pharma.on("POST", "/api/feedback", (_req, res) => sendJson(res, 200, { id: 42 }));

    await call("record_feedback", { rating: 4, response_id: "r-9", comment: "Good sources" });

    expect(harness.pharma.requests[0].body).toEqual({ rating: 4, response_id: "r-9", comment: "Good sources" });
  });

  it("rejects an out-of-range rating before calling PharmaLLM", async () => {
    const result = await call("record_feedback", { rating: 9 });
    expect(isToolError(result)).toBe(true);
    expect(harness.pharma.requests).toHaveLength(0);
  });

  it("maps report kinds to routes", async () => {
    harness.pharma.on("GET", "/api/feedback/weekly-digest", (_req, res) => sendJson(res, 200, { week: "ok" }));
    expect(JSON.parse(toolText(await call("feedback_report", { kind: "weekly_digest" })))).toEqual({ week: "ok" });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { ServerResponse } from "node:http";
import { createPharmaITChatClient, PharmaITChatError } from "../src/pharmaitchat-client.js";
import type { FetchImpl } from "../src/pharmaitchat-client.js";
import { sendJson, sendSse, startFakePharmaITChat } from "./helpers/fake-pharmaitchat.js";
import type { FakePharmaITChat } from "./helpers/fake-pharmaitchat.js";

let pharma: FakePharmaITChat;
// Responses a test left hanging on purpose; ended in cleanup so Jest exits cleanly
let stalled: ServerResponse[] = [];

beforeEach(async () => {
  pharma = await startFakePharmaITChat();
});

afterEach(async () => {
  for (const res of stalled) res.end();
  stalled = [];
  await pharma.close();
});

function rejectingFetch(code: string): FetchImpl {
  return async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
  };
}

describe("get and post", () => {
  it("sends the API token and parses JSON", async () => {
    pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy" }));
    const client = createPharmaITChatClient(pharma.url, "app-secret");

    await expect(client.get("/api/health")).resolves.toEqual({ status: "healthy" });
    expect(pharma.requests[0].headers.authorization).toBe("Bearer app-secret");
  });

  it("sends no Authorization header without a token and posts JSON", async () => {
    pharma.on("POST", "/api/knowledge/search", (_req, res) => sendJson(res, 200, { results: [] }));
    const client = createPharmaITChatClient(pharma.url, null);

    await client.post("/api/knowledge/search", { query: "Dell", topK: 5 });
    expect(pharma.requests[0].headers.authorization).toBeUndefined();
    expect(pharma.requests[0].body).toEqual({ query: "Dell", topK: 5 });
  });

  it("explains a rejected token", async () => {
    pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 401, { error: "Unauthorized" }));
    const client = createPharmaITChatClient(pharma.url, "wrong");

    await expect(client.get("/api/health")).rejects.toThrow(
      "PharmaITChat rejected the API token — check PHARMAITCHAT_API_TOKEN"
    );
  });

  it("includes status and PharmaITChat's error message", async () => {
    pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 503, { error: "Search refused: index incomplete" })
    );
    const client = createPharmaITChatClient(pharma.url, null);

    const error = await client.post("/api/knowledge/search", { query: "x" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PharmaITChatError);
    expect((error as PharmaITChatError).status).toBe(503);
    expect((error as PharmaITChatError).message).toBe(
      "PharmaITChat /api/knowledge/search failed (503): Search refused: index incomplete"
    );
  });

  it("reports an unreachable PharmaITChat", async () => {
    const client = createPharmaITChatClient("http://127.0.0.1:9", null);
    await expect(client.get("/api/health")).rejects.toThrow("PharmaITChat not reachable at http://127.0.0.1:9");
  });

  it("times out a slow request", async () => {
    pharma.on("GET", "/api/health", () => {
      // never answers
    });
    const client = createPharmaITChatClient(pharma.url, null);
    await expect(client.get("/api/health", 50)).rejects.toThrow("PharmaITChat did not answer within 0.05 s");
  });

  it("treats undici's own header and body timeouts as timeouts, not as unreachable", async () => {
    const headers = createPharmaITChatClient(pharma.url, null, rejectingFetch("UND_ERR_HEADERS_TIMEOUT"));
    await expect(headers.post("/api/agent/run", {}, 840_000)).rejects.toThrow(
      "PharmaITChat did not answer within 840 s"
    );

    const body = createPharmaITChatClient(pharma.url, null, rejectingFetch("UND_ERR_BODY_TIMEOUT"));
    await expect(body.get("/api/health", 5000)).rejects.toThrow("did not answer within");

    const refused = createPharmaITChatClient(pharma.url, null, rejectingFetch("ECONNREFUSED"));
    await expect(refused.get("/api/health", 5000)).rejects.toThrow("PharmaITChat not reachable at");
  });

  it("keeps the deadline running while the JSON body is read", async () => {
    pharma.on("GET", "/api/health", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"status":');
      stalled.push(res);
    });
    const client = createPharmaITChatClient(pharma.url, null);
    await expect(client.get("/api/health", 300)).rejects.toThrow("PharmaITChat did not answer within 0.3 s");
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
    const client = createPharmaITChatClient(pharma.url, null);

    await expect(client.ask("How does Dell protect backups?", false, 5000)).resolves.toEqual({
      answer: "Dell isolates backups.",
      sources: ["vendor-dell-cyber-recovery.md", "pharma-basics.md"],
      stack: "ollama",
      response_id: "r-1",
      timings: { totalMs: 1234 },
    });
    expect(pharma.requests[0].body).toEqual({ message: "How does Dell protect backups?", webSearch: false });
  });

  it("turns a stream error event into a PharmaITChatError", async () => {
    pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [{ error: "OLLAMA stack not reachable at http://localhost:11434/v1/chat/completions" }])
    );
    const client = createPharmaITChatClient(pharma.url, null);

    await expect(client.ask("hi", false, 5000)).rejects.toThrow("OLLAMA stack not reachable");
  });

  it("fails when the stream ends without an answer", async () => {
    pharma.on("POST", "/api/chat", (_req, res) => sendSse(res, [{ token: "partial" }]));
    const client = createPharmaITChatClient(pharma.url, null);

    await expect(client.ask("hi", false, 5000)).rejects.toThrow("PharmaITChat chat stream ended without an answer");
  });

  it("times out a chat stream that stalls after the first event", async () => {
    pharma.on("POST", "/api/chat", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ token: "Dell " })}\n\n`);
      stalled.push(res);
    });
    const client = createPharmaITChatClient(pharma.url, null);

    await expect(client.ask("hi", false, 300)).rejects.toThrow("PharmaITChat did not answer within 0.3 s");
  });
});

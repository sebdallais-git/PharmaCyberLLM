import { afterEach, describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import type { StackConfig } from "../src/config/llm-stacks.js";
import {
  QUERY_INSTRUCTION,
  StackUnavailableError,
  computeTokenStats,
  createLlmClient,
  formatEmbeddingInput,
  parseSseLines,
} from "../src/services/llm-client.js";
import type { StatsCollector } from "../src/services/llm-client.js";
import { sendJson, sendSse, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

const CLOSED_URL = "http://127.0.0.1:9";

function stackFor(baseUrl: string): StackConfig {
  return { ...buildStacks({}).mlx, chatBaseUrl: baseUrl, embedBaseUrl: baseUrl };
}

function delta(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("parseSseLines", () => {
  it("keeps an incomplete trailing line for the next read", () => {
    const first = parseSseLines('data: {"a":1}\n\ndata: {"b"');
    expect(first.events).toEqual(['{"a":1}']);
    const second = parseSseLines(first.rest + ":2}\n\n");
    expect(second.events).toEqual(['{"b":2}']);
    expect(second.rest).toBe("");
  });

  it("ignores comments and blank lines", () => {
    expect(parseSseLines(": keep-alive\n\ndata: [DONE]\n").events).toEqual(["[DONE]"]);
  });
});

describe("computeTokenStats", () => {
  it("measures TTFT and decode speed excluding the first token", () => {
    const stats = computeTokenStats({
      start: 1000,
      firstTokenAt: 1400,
      lastTokenAt: 1900,
      contentChunks: 6,
      usage: { prompt_tokens: 120, completion_tokens: 11 },
    });
    expect(stats.ttftMs).toBe(400);
    expect(stats.tokensPerSecond).toBeCloseTo(20); // 10 tokens after the first, in 500 ms
    expect(stats.promptTokens).toBe(120);
    expect(stats.completionTokens).toBe(11);
    expect(stats.tokenCountSource).toBe("usage");
  });

  it("counts content chunks when the server sends no usage", () => {
    const stats = computeTokenStats({ start: 0, firstTokenAt: 100, lastTokenAt: 300, contentChunks: 5, usage: null });
    expect(stats.completionTokens).toBe(5);
    expect(stats.tokensPerSecond).toBeCloseTo(20); // 4 tokens in 200 ms
    expect(stats.tokenCountSource).toBe("chunks");
  });

  it("reports zero when nothing was generated", () => {
    const stats = computeTokenStats({ start: 0, firstTokenAt: null, lastTokenAt: 0, contentChunks: 0, usage: null });
    expect(stats.ttftMs).toBe(0);
    expect(stats.tokensPerSecond).toBe(0);
  });
});

describe("formatEmbeddingInput", () => {
  it("adds the retrieval instruction to queries only", () => {
    expect(formatEmbeddingInput("What is SafeMode?", "query")).toBe(
      `Instruct: ${QUERY_INSTRUCTION}\nQuery:What is SafeMode?`
    );
    expect(formatEmbeddingInput("SafeMode snapshots are immutable.", "document")).toBe(
      "SafeMode snapshots are immutable."
    );
  });
});

describe("createLlmClient", () => {
  it("streams tokens, sends the stack's request fields, and collects stats", async () => {
    server = await startFakeServer((_req, res) =>
      sendSse(res, [
        delta("Hel"),
        delta("lo"),
        { choices: [], usage: { prompt_tokens: 42, completion_tokens: 2 } },
      ])
    );
    const ticks = [0, 250, 350];
    const client = createLlmClient(stackFor(server.baseUrl), () => ticks.shift() ?? 350);
    const stats: StatsCollector = {};
    const tokens: string[] = [];

    for await (const token of client.streamChat([{ role: "user", content: "hi" }], { temperature: 0 }, stats)) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(server.requests[0].url).toBe("/v1/chat/completions");
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.model).toBe("mlx-community/Qwen3.8-27B-4bit");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(4096);
    expect(stats.result).toEqual({
      promptTokens: 42,
      completionTokens: 2,
      tokensPerSecond: 10,
      ttftMs: 250,
      tokenCountSource: "usage",
    });
  });

  it("returns non-streaming content with the default temperature", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { choices: [{ message: { content: "pong" } }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.chat([{ role: "user", content: "ping" }])).resolves.toBe("pong");
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(4096);
  });

  it("sends an explicit max_tokens override", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.chat([{ role: "user", content: "hi" }], { maxTokens: 1024 })).resolves.toBe("ok");
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.max_tokens).toBe(1024);
  });

  it("returns embeddings in input order", async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, 200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })
    );
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.embedMany(["a", "b"], "document")).resolves.toEqual([[1, 0], [0, 1]]);
    expect(server.requests[0].url).toBe("/v1/embeddings");
    const body = server.requests[0].body as { model: string; input: string[] };
    expect(body.model).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
    expect(body.input).toEqual(["a", "b"]);
  });

  it("rejects a response with the wrong number of embeddings", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { data: [{ index: 0, embedding: [1] }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.embedMany(["a", "b"], "document")).rejects.toThrow("expected 2 embeddings, got 1");
  });

  it("lists models and reports reachability", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { data: [{ id: "x" }, { id: "y" }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.listModels()).resolves.toEqual(["x", "y"]);
    await expect(client.isReachable()).resolves.toBe(true);
    await expect(createLlmClient(stackFor(CLOSED_URL)).isReachable()).resolves.toBe(false);
  });

  it("fails with a clear error and no fallback when the stack is down", async () => {
    const client = createLlmClient(stackFor(CLOSED_URL));

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(StackUnavailableError);
    await expect(client.embed("hi", "query")).rejects.toThrow(
      `MLX stack not reachable at ${CLOSED_URL}/v1/embeddings — run scripts/switch-stack.sh mlx`
    );
  });

  it("surfaces HTTP errors with status and body", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("model not loaded");
    });
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      "mlx /v1/chat/completions failed (500): model not loaded"
    );
  });

  it("rejects on a malformed stream chunk", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {not json\n\n");
      res.end();
    });
    const client = createLlmClient(stackFor(server.baseUrl));
    const stats: StatsCollector = {};

    async function consume(): Promise<void> {
      for await (const _token of client.streamChat([{ role: "user", content: "hi" }], {}, stats)) {
        // no-op
      }
    }

    await expect(consume()).rejects.toThrow(SyntaxError);
    expect(stats.result).toBeUndefined();
  });

  it(
    "releases the stream when the consumer stops early",
    async () => {
      server = await startFakeServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(delta("Hel"))}\n\n`);
        // Deliberately never call res.end() — the client must cancel the reader itself.
      });
      const client = createLlmClient(stackFor(server.baseUrl));

      for await (const token of client.streamChat([{ role: "user", content: "hi" }])) {
        expect(token).toBe("Hel");
        break;
      }

      await server.close();
      server = null;
    },
    5000
  );
});

describe("thinking level in the outgoing request", () => {
  // The switch is only real if the level reaches the model. Default must stay
  // off so benchmarks, MCP and every existing caller are unaffected.
  it("sends thinking disabled when no level is requested", async () => {
    server = await startFakeServer((_req, res) => sendSse(res, [delta("hi"), "[DONE]"]));
    const client = createLlmClient(stackFor(server.baseUrl));

    for await (const _ of client.streamChat([{ role: "user", content: "q" }])) void _;

    const body = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("enables thinking when the level asks for it", async () => {
    server = await startFakeServer((_req, res) => sendSse(res, [delta("hi"), "[DONE]"]));
    const client = createLlmClient(stackFor(server.baseUrl));

    for await (const _ of client.streamChat([{ role: "user", content: "q" }], { thinking: "on" })) void _;

    const body = server.requests.at(-1)?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});

describe("reasoning from the stream", () => {
  // mlx_lm 0.31.3 returns model thinking as `delta.reasoning`, a sibling of
  // `delta.content` -- it never emits <think> tags. Verified against the live
  // server on 2026-09-21.
  it("surfaces reasoning separately and keeps it out of the answer", async () => {
    server = await startFakeServer((_req, res) =>
      sendSse(res, [
        { choices: [{ delta: { reasoning: "weighing " } }] },
        { choices: [{ delta: { reasoning: "options" } }] },
        delta("the answer"),
        "[DONE]",
      ]),
    );
    const client = createLlmClient(stackFor(server.baseUrl));
    const reasoning: string[] = [];
    let answer = "";

    for await (const token of client.streamChat([{ role: "user", content: "q" }], {
      thinking: "on",
      onReasoning: (text) => reasoning.push(text),
    })) {
      answer += token;
    }

    expect(reasoning.join("")).toBe("weighing options");
    expect(answer).toBe("the answer");
  });
});

import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildStacks } from "../src/config/llm-stacks.js";
import type { StackConfig } from "../src/config/llm-stacks.js";
import { buildUpstreamBody, forwardChatCompletion, GatewayError, modelList } from "../src/services/model-gateway.js";
import type { GatewayDeps } from "../src/services/model-gateway.js";
import { sendJson, sendSse, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

const CLOSED_URL = "http://127.0.0.1:9";

function mlxStackAt(url: string): StackConfig {
  return { ...buildStacks({}).mlx, chatBaseUrl: url, embedBaseUrl: url };
}

let upstream: FakeServer | null = null;
let gateway: Server | null = null;

afterEach(async () => {
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    gateway = null;
  }
  await upstream?.close();
  upstream = null;
});

async function startGateway(overrides: Partial<GatewayDeps> & { stack: StackConfig }): Promise<string> {
  const deps: GatewayDeps = {
    fetchImpl: fetch,
    isBenchmarkActive: () => false,
    trackJob: async <T>(_name: string, job: () => Promise<T>) => job(),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.post("/v1/chat/completions", (req, res) => {
    void forwardChatCompletion(req.body, res, deps);
  });
  gateway = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1/chat/completions`;
}

const toolRequest = {
  model: "gpt-4o",
  n: 3,
  messages: [{ role: "user", content: "Weather in Basel?" }],
  tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
  tool_choice: "auto",
};

describe("buildUpstreamBody", () => {
  const mlx = buildStacks({}).mlx;

  it("forces the stack model, merges the stack's extra body and passes tool fields", () => {
    expect(buildUpstreamBody(toolRequest, mlx)).toEqual({
      messages: toolRequest.messages,
      tools: toolRequest.tools,
      tool_choice: "auto",
      max_tokens: 4096,
      model: "mlx-community/Qwen3.8-27B-4bit",
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("keeps smaller max_tokens and caps larger ones", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(buildUpstreamBody({ messages, max_tokens: 512 }, mlx).max_tokens).toBe(512);
    expect(buildUpstreamBody({ messages, max_tokens: 100000 }, mlx).max_tokens).toBe(4096);
  });

  it("rejects a request without messages", () => {
    expect(() => buildUpstreamBody({ model: "x" }, mlx)).toThrow(GatewayError);
    expect(() => buildUpstreamBody({ messages: [] }, mlx)).toThrow("messages must be a non-empty array");
  });

  it("lists only the stack's chat model", () => {
    expect(modelList(mlx)).toEqual({
      object: "list",
      data: [{ id: "mlx-community/Qwen3.8-27B-4bit", object: "model", created: 0, owned_by: "pharmallm" }],
    });
  });
});

describe("forwardChatCompletion", () => {
  it("passes a non-streaming tool call response through", async () => {
    const completion = {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function" }] } }],
    };
    upstream = await startFakeServer((_req, res) => sendJson(res, 200, completion));
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl) });

    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toolRequest) });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(completion);
    expect(upstream.requests[0].url).toBe("/v1/chat/completions");
    expect((upstream.requests[0].body as { model: string }).model).toBe("mlx-community/Qwen3.8-27B-4bit");
  });

  it("streams server-sent events through unchanged", async () => {
    upstream = await startFakeServer((_req, res) =>
      sendSse(res, [{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }])
    );
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl) });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const text = await resp.text();

    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('data: {"choices":[{"delta":{"content":"Hel"}}]}');
    expect(text).toContain('data: {"choices":[{"delta":{"content":"lo"}}]}');
    expect(text).toContain("data: [DONE]");
  });

  it("passes upstream error statuses through", async () => {
    upstream = await startFakeServer((_req, res) => sendJson(res, 500, { error: { message: "model crashed" } }));
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl) });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: { message: "model crashed" } });
  });

  it("refuses during benchmark mode without calling the stack", async () => {
    upstream = await startFakeServer((_req, res) => sendJson(res, 200, {}));
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl), isBenchmarkActive: () => true });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({
      error: { message: "Benchmark in progress — try again after it finishes", type: "service_unavailable" },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("returns 503 when the stack is down and tracks the job", async () => {
    const jobs: string[] = [];
    const url = await startGateway({
      stack: mlxStackAt(CLOSED_URL),
      trackJob: async <T>(name: string, job: () => Promise<T>) => {
        jobs.push(name);
        return job();
      },
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { error: { message: string } }).error.message).toContain("MLX stack not reachable");
    expect(jobs).toEqual(["agent-completion"]);
  });

  it("returns 400 for an invalid request", async () => {
    const url = await startGateway({ stack: mlxStackAt(CLOSED_URL) });

    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({
      error: { message: "messages must be a non-empty array", type: "invalid_request_error" },
    });
  });
});

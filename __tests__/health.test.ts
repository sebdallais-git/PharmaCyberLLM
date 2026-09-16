import { afterEach, describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import { aggregateHealth, probeUrl, stackProbeUrls } from "../src/services/health.js";
import { sendJson, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("stackProbeUrls", () => {
  it("probes only the active stack's endpoints", () => {
    const { ollama, mlx } = buildStacks({});
    const ollamaUrls = Object.values(stackProbeUrls(ollama));
    const mlxUrls = Object.values(stackProbeUrls(mlx));

    expect(ollamaUrls).toEqual(["http://localhost:11434/v1/models", "http://localhost:11434/v1/models"]);
    expect(mlxUrls).toEqual(["http://localhost:8080/v1/models", "http://localhost:8081/v1/models"]);
    expect(ollamaUrls.some((url) => url.includes(":8080") || url.includes(":8081"))).toBe(false);
    expect(mlxUrls.some((url) => url.includes(":11434"))).toBe(false);
  });
});

describe("aggregateHealth", () => {
  const up = { status: "ok" as const };
  const down = { status: "unreachable" as const };

  it("is healthy when everything is ok", () => {
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: up, searxng: up })).toBe("healthy");
  });

  it("is degraded when only a supporting service is down", () => {
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: up, searxng: down })).toBe("degraded");
  });

  it("is unhealthy when the stack or the search index is down", () => {
    expect(aggregateHealth({ llm_chat: down, llm_embed: up, search_index: up })).toBe("unhealthy");
    expect(aggregateHealth({ llm_chat: up, llm_embed: down, search_index: up })).toBe("unhealthy");
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: { status: "error" } })).toBe("unhealthy");
  });
});

describe("probeUrl", () => {
  it("reports ok, error and unreachable", async () => {
    server = await startFakeServer((req, res) => sendJson(res, req.url === "/ok" ? 200 : 500, {}));

    const ok = await probeUrl(`${server.baseUrl}/ok`);
    expect(ok.status).toBe("ok");
    expect(typeof ok.latency_ms).toBe("number");
    expect((await probeUrl(`${server.baseUrl}/fail`)).status).toBe("error");
    expect((await probeUrl("http://127.0.0.1:9/")).status).toBe("unreachable");
  });
});

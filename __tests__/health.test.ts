import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStacks } from "../src/config/llm-stacks.js";
import {
  aggregateHealth,
  CRITICAL_CHECKS,
  isScorerConfigured,
  probeGeneration,
  probeUrl,
  scorerInstallPaths,
  stackProbeUrls,
} from "../src/services/health.js";
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

describe("generation probe", () => {
  // /v1/models answers from a wedged server: on 2026-09-22 MLX sat at 0% CPU
  // accepting connections and serving /v1/models while a 5-token generation
  // timed out at 90s, and /api/health reported llm_chat ok throughout. Liveness
  // is not readiness -- only generating a token proves the model works.
  it("reports ok when the model actually produces a token", async () => {
    const server = await startFakeServer((_req, res) =>
      sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }),
    );
    try {
      const check = await probeGeneration(server.baseUrl, 5000);
      expect(check.status).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("reports unreachable when generation hangs, even though the port is open", async () => {
    // Never responds: the wedged case, which a /v1/models probe would pass.
    const server = await startFakeServer(() => {});
    try {
      const check = await probeGeneration(server.baseUrl, 300);
      expect(check.status).toBe("unreachable");
    } finally {
      await server.close();
    }
  });
});

describe("the scorer is a non-critical dependency", () => {
  // Chat must keep working with the scorer down: only the gap-resolution loop
  // depends on it, and that loop degrades to "no decision" rather than to a
  // wrong one.
  it("is not in CRITICAL_CHECKS", () => {
    expect(CRITICAL_CHECKS).toEqual(["llm_chat", "llm_embed", "search_index"]);
    expect(CRITICAL_CHECKS).not.toContain("jev");
  });

  it("degrades rather than fails the app when the scorer is unreachable", () => {
    const status = aggregateHealth({
      llm_chat: { status: "ok" },
      llm_embed: { status: "ok" },
      search_index: { status: "ok" },
      jev: { status: "unreachable" },
    });

    expect(status).toBe("degraded");
  });

  it("still reports unhealthy when a critical check is down, scorer or not", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "unreachable" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
        jev: { status: "ok" },
      }),
    ).toBe("unhealthy");
  });

  // Installing the scorer is optional and skippable (scripts/hermes-setup.sh
  // returns 0 without it). On a machine where it was skipped, probing it and
  // reporting "unreachable" pinned /api/health at degraded forever, and
  // check-services.sh prints anything but "healthy" red -- the one place this
  // feature made the app behave WORSE with the scorer absent than before it
  // existed. A dependency that was never installed is not a fault.
  it("stays healthy when the scorer was never installed", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "ok" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
        jev: { status: "not_configured" },
      }),
    ).toBe("healthy");
  });

  it("does not let not_configured excuse a critical check", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "not_configured" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
      }),
    ).toBe("unhealthy");
  });
});

describe("scorerInstallPaths / isScorerConfigured", () => {
  // The same two artifacts scripts/hermes-setup.sh requires and renders. No
  // launchctl, no scorer, no network: two paths on disk.
  const jevDir = mkdtempSync(join(tmpdir(), "jev-"));
  const launchAgentsDir = mkdtempSync(join(tmpdir(), "agents-"));
  const paths = { plist: join(launchAgentsDir, "com.pharmaitchat.jev.plist"), binary: join(jevDir, ".venv", "bin", "openjev") };

  it("derives the plist and venv paths from the same env vars as hermes-setup.sh", () => {
    const derived = scorerInstallPaths({ LAUNCH_AGENTS_DIR: launchAgentsDir, JEV_DIR: jevDir });

    expect(derived).toEqual(paths);
  });

  it("is not configured while either artifact is missing", () => {
    expect(isScorerConfigured(paths)).toBe(false);

    mkdirSync(join(jevDir, ".venv", "bin"), { recursive: true });
    writeFileSync(paths.binary, "#!/bin/sh\n");
    expect(isScorerConfigured(paths)).toBe(false); // venv but no launch agent

    writeFileSync(paths.plist, "<plist/>");
    expect(isScorerConfigured(paths)).toBe(true);
  });
});

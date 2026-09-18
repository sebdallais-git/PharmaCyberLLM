import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStackRouter } from "../src/api/stack.js";
import { createStackSwitch } from "../src/services/stack-switch.js";
import type { StackName } from "../src/config/llm-stacks.js";
import type { SwitchProgress } from "../src/services/stack-switch.js";

const BOT_MESSAGE_TOKEN_PATTERN = /token=([a-zA-Z0-9_-]+)/;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
});

interface Fixture {
  url: string;
  messages: string[];
  spawned: StackName[];
  state: {
    active: StackName;
    benchmark: boolean;
    jobs: string[];
    progress: SwitchProgress | null;
    configured: boolean;
    sendFails: boolean;
    sendFailMessage: string;
  };
}

async function startApp(): Promise<Fixture> {
  const state = {
    active: "ollama" as StackName,
    benchmark: false,
    jobs: [] as string[],
    progress: null as SwitchProgress | null,
    configured: true,
    sendFails: false,
    sendFailMessage: "telegram sendMessage failed (401)",
  };
  const messages: string[] = [];
  const spawned: StackName[] = [];
  let counter = 0;
  const switcher = createStackSwitch({
    now: () => Date.now(),
    newId: () => `id-${++counter}`,
    newToken: () => `tok-${counter}`,
    activeStack: () => state.active,
    isBenchmarkActive: () => state.benchmark,
    runningJobs: () => state.jobs,
    // Same underlying state readProgress() below reads, matching the production wiring in
    // src/api/stack.ts (both the route and the state machine read the one progress file).
    currentProgress: () => state.progress,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/stack",
    createStackRouter({
      switcher,
      sendTelegram: async (text: string) => {
        if (state.sendFails) throw new Error(state.sendFailMessage);
        messages.push(text);
      },
      spawnSwitch: (target: StackName) => {
        spawned.push(target);
      },
      activeStack: () => state.active,
      readProgress: () => state.progress,
      confirmBaseUrl: () => "https://mac:3443",
      telegramConfigured: () => state.configured,
    })
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, messages, spawned, state };
}

async function post(url: string, stack: string) {
  const res = await fetch(`${url}/api/stack/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stack }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postRaw(url: string, body: unknown) {
  const res = await fetch(`${url}/api/stack/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/stack/switch", () => {
  it("accepts a switch, sends exactly one Telegram message with a confirm link, and starts nothing yet", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(202);
    expect(body.status).toBe("pending_confirmation");
    expect(typeof body.expires_at).toBe("number");
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]).toContain("omlx");
    expect(fixture.messages[0]).toMatch(BOT_MESSAGE_TOKEN_PATTERN);
    expect(fixture.messages[0]).toContain("https://mac:3443/api/stack/confirm?token=");
    expect(fixture.spawned).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
  });

  it("refuses an unknown stack name", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "vllm");

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/ollama, mlx or omlx/);
    expect(fixture.messages).toEqual([]);
  });

  it("refuses a non-string stack value and spawns nothing", async () => {
    const fixture = await startApp();

    const arrayBody = await postRaw(fixture.url, { stack: ["omlx"] });
    const missingBody = await postRaw(fixture.url, {});

    expect(arrayBody.status).toBe(400);
    expect(missingBody.status).toBe(400);
    expect(fixture.messages).toEqual([]);
    expect(fixture.spawned).toEqual([]);
  });

  it("passes the state machine's refusal through as 409", async () => {
    const fixture = await startApp();
    fixture.state.jobs = ["reindex"];

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("reindex");
    expect(fixture.messages).toEqual([]);
  });

  it("refuses a switch to the already-active stack", async () => {
    const fixture = await startApp();
    fixture.state.active = "omlx";

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("already_active");
    expect(fixture.messages).toEqual([]);
  });

  it("refuses a switch while a benchmark is running", async () => {
    const fixture = await startApp();
    fixture.state.benchmark = true;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("benchmark");
    expect(fixture.messages).toEqual([]);
  });

  // F1: the same 409 shape as the other three refusal reasons, for a switch that is actively
  // running (a non-terminal phase, e.g. because a second browser or a page reload posted again
  // after the Telegram link was tapped but before the switch finished).
  it("refuses a switch while a previous switch is actively running, with the same 409 shape as the other reasons", async () => {
    const fixture = await startApp();
    fixture.state.progress = { phase: "warming", target: "mlx", previous: "ollama", startedAt: Date.now() };

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("switching");
    expect(typeof body.error).toBe("string");
    expect(fixture.messages).toEqual([]);
    expect(fixture.spawned).toEqual([]);
  });

  it("never leaks the bot token in a failed-send response", async () => {
    const fixture = await startApp();
    const fakeToken = "bot123456789:ABCdefGHIjkLMNOpqrSTUvwxYZ01234567890";
    fixture.state.sendFails = true;
    // Simulate an underlying error message that happens to carry a token-shaped string
    // (e.g. embedded in a leaked request URL) to prove the route never echoes it back.
    fixture.state.sendFailMessage = `telegram sendMessage failed: fetch https://api.telegram.org/${fakeToken}/sendMessage`;

    const refused = await postRaw(fixture.url, { stack: "omlx" });

    expect(refused.status).toBe(502);
    const raw = JSON.stringify(refused.body);
    expect(raw).not.toContain(fakeToken);
    expect(raw).not.toMatch(/https:\/\/api\.telegram\.org/);
  });

  it("refuses when Telegram is not configured", async () => {
    const fixture = await startApp();
    fixture.state.configured = false;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("telegram_unconfigured");
    expect(fixture.spawned).toEqual([]);
  });

  it("leaves no pending switch when the message cannot be sent", async () => {
    const fixture = await startApp();
    fixture.state.sendFails = true;

    const refused = await post(fixture.url, "omlx");

    expect(refused.status).toBe(502);
    expect(String(refused.body.error)).toMatch(/Could not send the Telegram confirmation/);
    expect(fixture.spawned).toEqual([]);

    // Nobody was asked, so nobody can confirm: the next request must be accepted
    fixture.state.sendFails = false;
    expect((await post(fixture.url, "omlx")).status).toBe(202);
  });
});

describe("GET /api/stack/confirm", () => {
  it("spawns the switch once for a good token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    const token = BOT_MESSAGE_TOKEN_PATTERN.exec(fixture.messages[0])?.[1] ?? "";

    const first = await fetch(`${fixture.url}/api/stack/confirm?token=${token}`);
    const second = await fetch(`${fixture.url}/api/stack/confirm?token=${token}`);

    expect(first.status).toBe(200);
    expect((await first.text()).toLowerCase()).toContain("omlx");
    expect(second.status).toBe(410);
    expect(fixture.spawned).toEqual(["omlx"]);
  });

  it("refuses an unknown token without spawning", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/stack/confirm?token=nope`);

    expect(res.status).toBe(410);
    expect(fixture.spawned).toEqual([]);
  });
});

describe("GET /api/stack/status", () => {
  it("reports the active stack, the pending target and the progress, never the token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    fixture.state.progress = { phase: "warming", target: "omlx", previous: "ollama", startedAt: 10 };

    const res = await fetch(`${fixture.url}/api/stack/status`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.active).toBe("ollama");
    expect(body.stacks).toEqual(["ollama", "mlx", "omlx"]);
    expect((body.pending as Record<string, unknown>).target).toBe("omlx");
    expect((body.progress as Record<string, unknown>).phase).toBe("warming");
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
  });
});

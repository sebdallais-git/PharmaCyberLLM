import { afterEach, describe, expect, it } from "@jest/globals";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHermesReadiness,
  evaluateReadiness,
  hermesHome,
  queryGatewayStatus,
  READINESS_CACHE_MS,
  readPluginReadyFile,
} from "../src/services/hermes-readiness.js";

const RUNNING = {
  pid: 4242,
  start_time: 777,
  gateway_state: "running",
  platforms: { telegram: { state: "connected" } },
};
const READY_FILE = { pid: 4242, start_time: 777 };

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hr-"));
  dirs.push(dir);
  return dir;
}

// A test-owned stand-in for Hermes' control socket: answers one line, then closes (or stays silent)
async function fakeGateway(reply: string | null): Promise<string> {
  const path = join(tempDir(), "g.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      if (reply !== null) socket.end(`${reply}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  servers.push(server);
  return path;
}

describe("evaluateReadiness", () => {
  it("is ready when the gateway runs, Telegram is connected and the plugin was loaded by this gateway", () => {
    expect(evaluateReadiness(RUNNING, READY_FILE)).toEqual({ ready: true, reason: "" });
  });

  it("names each way it can fail", () => {
    expect(evaluateReadiness(null, READY_FILE).reason).toMatch(/gateway is not running/);
    expect(evaluateReadiness({ ...RUNNING, gateway_state: "draining" }, READY_FILE).reason).toMatch(/draining/);
    expect(
      evaluateReadiness({ ...RUNNING, platforms: { telegram: { state: "retrying" } } }, READY_FILE).reason
    ).toMatch(/not connected to Telegram/);
    expect(evaluateReadiness(RUNNING, null).reason).toMatch(/plugin is not loaded/);
    expect(evaluateReadiness(RUNNING, { pid: 4242, start_time: 1 }).reason).toMatch(/earlier gateway process/);
    expect(evaluateReadiness(RUNNING, { pid: 1, start_time: 777 }).reason).toMatch(/earlier gateway process/);
    expect(evaluateReadiness({ ...RUNNING, pid: undefined }, READY_FILE).ready).toBe(false);
  });
});

describe("queryGatewayStatus", () => {
  it("sends the status verb and returns the result object", async () => {
    const path = await fakeGateway(JSON.stringify({ ok: true, protocol: 1, result: RUNNING }));
    expect(await queryGatewayStatus(path)).toEqual(RUNNING);
  });

  it("returns null when nothing listens, the reply is not ok, or the gateway stays silent", async () => {
    expect(await queryGatewayStatus(join(tempDir(), "absent.sock"))).toBeNull();
    expect(await queryGatewayStatus(await fakeGateway(JSON.stringify({ ok: false })))).toBeNull();
    expect(await queryGatewayStatus(await fakeGateway("not json"))).toBeNull();
    expect(await queryGatewayStatus(await fakeGateway(null), 100)).toBeNull();
  });
});

describe("readPluginReadyFile", () => {
  it("parses the file, or returns null when it is missing or broken", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ok.json"), JSON.stringify(READY_FILE));
    writeFileSync(join(dir, "bad.json"), "{");
    expect(readPluginReadyFile(join(dir, "ok.json"))).toEqual(READY_FILE);
    expect(readPluginReadyFile(join(dir, "bad.json"))).toBeNull();
    expect(readPluginReadyFile(join(dir, "missing.json"))).toBeNull();
  });
});

describe("createHermesReadiness", () => {
  it("serves cached() from memory for 5 s but always re-queries on check()", async () => {
    const clock = { value: 0 };
    let queries = 0;
    const readiness = createHermesReadiness({
      queryGatewayStatus: async () => {
        queries += 1;
        return RUNNING;
      },
      readPluginReadyFile: () => READY_FILE,
      now: () => clock.value,
    });

    expect((await readiness.cached()).ready).toBe(true);
    clock.value = READINESS_CACHE_MS - 1;
    await readiness.cached();
    expect(queries).toBe(1);
    await readiness.check();
    expect(queries).toBe(2);
    clock.value += READINESS_CACHE_MS;
    await readiness.cached();
    expect(queries).toBe(3);
  });
});

describe("hermesHome", () => {
  it("honours HERMES_HOME and falls back to ~/.hermes", () => {
    expect(hermesHome({ HERMES_HOME: "/x/h" })).toBe("/x/h");
    expect(hermesHome({})).toMatch(/\.hermes$/);
  });
});

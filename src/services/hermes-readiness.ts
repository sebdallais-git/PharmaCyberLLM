// Can the Hermes gateway receive a stack-switch button tap? The app shares Hermes' bot and Hermes is
// its only update consumer, so the tap reaches us only through the pharmaitchat-switch plugin. Ready
// means the gateway runs, Telegram is connected, and the plugin's ready file names this very gateway
// process: pid and start time together, since a pid alone can be reused after a crash.

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const READINESS_CACHE_MS = 5000;

export interface HermesReadiness {
  ready: boolean;
  reason: string;
}

export interface HermesReadinessDeps {
  queryGatewayStatus(): Promise<unknown>;
  readPluginReadyFile(): unknown;
  now(): number;
}

export interface HermesReadinessChecker {
  check(): Promise<HermesReadiness>;
  cached(): Promise<HermesReadiness>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function evaluateReadiness(status: unknown, readyFile: unknown): HermesReadiness {
  const gateway = asRecord(status);
  if (!gateway) return { ready: false, reason: "the Hermes gateway is not running" };
  if (gateway.gateway_state !== "running") {
    return { ready: false, reason: `the Hermes gateway is ${String(gateway.gateway_state ?? "in an unknown state")}` };
  }
  const telegram = asRecord(asRecord(gateway.platforms)?.telegram);
  if (telegram?.state !== "connected") return { ready: false, reason: "Hermes is not connected to Telegram" };
  const plugin = asRecord(readyFile);
  if (!plugin) {
    return { ready: false, reason: "the pharmaitchat-switch plugin is not loaded (scripts/hermes-setup.sh install-plugin)" };
  }
  if (typeof gateway.pid !== "number" || plugin.pid !== gateway.pid || plugin.start_time !== gateway.start_time) {
    return { ready: false, reason: "the pharmaitchat-switch plugin was loaded by an earlier gateway process; restart the gateway" };
  }
  return { ready: true, reason: "" };
}

// One request per connection, as Hermes' control socket expects; any failure reads as "not running"
export function queryGatewayStatus(socketPath: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const socket = createConnection({ path: socketPath });
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb: "status", v: 1 })}\n`));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => {
      try {
        const reply = asRecord(JSON.parse(data) as unknown);
        finish(reply?.ok === true ? (reply.result ?? null) : null);
      } catch {
        finish(null);
      }
    });
    socket.on("close", () => finish(null));
  });
}

export function readPluginReadyFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

export function createHermesReadiness(deps: HermesReadinessDeps): HermesReadinessChecker {
  let memo: { at: number; value: HermesReadiness } | null = null;

  const check = async (): Promise<HermesReadiness> => {
    const value = evaluateReadiness(await deps.queryGatewayStatus(), deps.readPluginReadyFile());
    memo = { at: deps.now(), value };
    return value;
  };

  return {
    check,
    async cached() {
      if (memo && deps.now() - memo.at < READINESS_CACHE_MS) return memo.value;
      return check();
    },
  };
}

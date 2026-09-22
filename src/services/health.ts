// Stack-aware health checks: only the active stack's endpoints are probed

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { StackConfig } from "../config/llm-stacks.js";

// "not_configured" is for an OPTIONAL dependency that was never installed, as
// opposed to one that is installed and down ("unreachable"). The distinction
// matters because a probe cannot draw it: a port nobody ever listened on and a
// service that just crashed look identical from the outside.
export interface HealthCheck {
  status: "ok" | "error" | "unreachable" | "not_configured";
  latency_ms?: number;
  detail?: string;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

// Chat can't work without these; anything else only degrades answers
export const CRITICAL_CHECKS: readonly string[] = ["llm_chat", "llm_embed", "search_index"];

export function stackProbeUrls(stack: StackConfig): { llm_chat: string; llm_embed: string } {
  return {
    llm_chat: `${stack.chatBaseUrl}/v1/models`,
    llm_embed: `${stack.embedBaseUrl}/v1/models`,
  };
}

/**
 * Ask the model for a single token.
 *
 * /v1/models answers from a wedged server: on 2026-09-22 MLX sat at 0% CPU,
 * accepted connections and served /v1/models while a 5-token generation timed
 * out at 90s -- and /api/health reported llm_chat "ok" the whole time. A port
 * being open is liveness; producing a token is readiness, and only the second
 * one means chat works.
 */
export async function probeGeneration(baseUrl: string, timeoutMs: number = 20000): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // max_tokens 1 keeps this cheap when healthy; when wedged it costs the
      // timeout, which is the point.
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: resp.ok ? "ok" : "error", latency_ms: Date.now() - start };
  } catch {
    return { status: "unreachable" };
  }
}

export async function probeUrl(url: string, timeoutMs: number = 3000): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: resp.ok ? "ok" : "error", latency_ms: Date.now() - start };
  } catch {
    return { status: "unreachable" };
  }
}

export function aggregateHealth(checks: Record<string, HealthCheck>): HealthStatus {
  const entries = Object.entries(checks);
  // Critical first, and strictly "ok": nothing excuses a critical check, least
  // of all a claim that it was never configured.
  const criticalDown = entries.some(([name, check]) => CRITICAL_CHECKS.includes(name) && check.status !== "ok");
  if (criticalDown) return "unhealthy";
  // An optional dependency that was never installed is not a fault, so it does
  // not degrade the app. Anything installed and misbehaving still does.
  const fine = entries.every(([, check]) => check.status === "ok" || check.status === "not_configured");
  return fine ? "healthy" : "degraded";
}

export interface ScorerInstallPaths {
  plist: string;
  binary: string;
}

/**
 * The two artifacts that decide whether the scorer is installed on this
 * machine, read from the same env vars and the same defaults as
 * scripts/hermes-setup.sh: the launch agent it renders, and the open-jev venv
 * it refuses to install without. Asking about these files rather than about a
 * port is what lets /api/health tell "never installed" from "installed and
 * down" -- the scorer is optional by design, and only the second one is a
 * fault.
 */
export function scorerInstallPaths(env: NodeJS.ProcessEnv = process.env): ScorerInstallPaths {
  const launchAgentsDir = env.LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
  const jevDir = env.JEV_DIR ?? resolve(process.cwd(), "..", "open-jev");
  return {
    plist: join(launchAgentsDir, "com.pharmaitchat.jev.plist"),
    binary: join(jevDir, ".venv", "bin", "openjev"),
  };
}

export function isScorerConfigured(paths: ScorerInstallPaths = scorerInstallPaths()): boolean {
  return existsSync(paths.plist) && existsSync(paths.binary);
}

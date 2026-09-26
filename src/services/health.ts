// Stack-aware health checks: only the active stack's endpoints are probed

import type { StackConfig } from "../config/llm-stacks.js";

export interface HealthCheck {
  status: "ok" | "error" | "unreachable";
  latency_ms?: number;
  detail?: string;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

// scripts/check-services.sh must wait longer than this for /api/health
export const GENERATION_PROBE_TIMEOUT_MS = 20000;

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
export async function probeGeneration(
  stack: Pick<StackConfig, "chatBaseUrl" | "chatModel">,
  timeoutMs: number = GENERATION_PROBE_TIMEOUT_MS,
): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const resp = await fetch(`${stack.chatBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // max_tokens 1 keeps this cheap when healthy; when wedged it costs the
      // timeout, which is the point. The model is required by every stack
      // except mlx_lm.server, which falls back to the one it loaded.
      body: JSON.stringify({
        model: stack.chatModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: resp.ok ? "ok" : "error", latency_ms: Date.now() - start };
  } catch (err) {
    // The chat server takes one request at a time, so a long chat turn or an
    // export makes this time out too. It cannot tell the two apart; say so.
    // By name, not instanceof: the DOMException may come from another realm.
    if (typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError") {
      return { status: "unreachable", detail: `no token within ${timeoutMs / 1000}s: busy with another request, or wedged` };
    }
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
  if (entries.every(([, check]) => check.status === "ok")) return "healthy";
  const criticalDown = entries.some(([name, check]) => CRITICAL_CHECKS.includes(name) && check.status !== "ok");
  return criticalDown ? "unhealthy" : "degraded";
}

// Stack-aware health checks: only the active stack's endpoints are probed

import type { StackConfig } from "../config/llm-stacks.js";

export interface HealthCheck {
  status: "ok" | "error" | "unreachable";
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

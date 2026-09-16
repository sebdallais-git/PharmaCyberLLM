// Benchmark mode: while active, background LLM jobs skip their runs so benchmarks get the GPU to themselves

export interface ChatTimings {
  embedMs: number;
  retrievalMs: number;
  ttftMs: number;
  decodeTokPerSec: number;
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
}

// Benchmark mode is a lease: a benchmark that crashes without calling stop can't pause background jobs forever
export const BENCHMARK_LEASE_MS = 15 * 60 * 1000;

export interface BenchmarkStatus {
  active: boolean;
  expiresAt: string | null;
}

let benchmarkExpiresAt: number | null = null;

// Count per job name so overlapping runs of the same job are tracked correctly
const runningJobs = new Map<string, number>();

// Starting again refreshes the lease
export function setBenchmarkActive(active: boolean, now: number = Date.now()): void {
  benchmarkExpiresAt = active ? now + BENCHMARK_LEASE_MS : null;
}

export function isBenchmarkActive(now: number = Date.now()): boolean {
  if (benchmarkExpiresAt === null) return false;
  if (now >= benchmarkExpiresAt) {
    benchmarkExpiresAt = null;
    return false;
  }
  return true;
}

export function getBenchmarkStatus(now: number = Date.now()): BenchmarkStatus {
  const active = isBenchmarkActive(now);
  return { active, expiresAt: active && benchmarkExpiresAt !== null ? new Date(benchmarkExpiresAt).toISOString() : null };
}

export function markJobStarted(name: string): void {
  runningJobs.set(name, (runningJobs.get(name) ?? 0) + 1);
}

export function markJobFinished(name: string): void {
  const remaining = (runningJobs.get(name) ?? 0) - 1;
  if (remaining > 0) {
    runningJobs.set(name, remaining);
  } else {
    runningJobs.delete(name);
  }
}

export function getRunningJobs(): string[] {
  return [...runningJobs.keys()].sort();
}

export async function trackJob<T>(name: string, job: () => Promise<T>): Promise<T> {
  markJobStarted(name);
  try {
    return await job();
  } finally {
    markJobFinished(name);
  }
}

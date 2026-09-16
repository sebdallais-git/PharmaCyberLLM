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

let benchmarkActive = false;

// Count per job name so overlapping runs of the same job are tracked correctly
const runningJobs = new Map<string, number>();

export function setBenchmarkActive(active: boolean): void {
  benchmarkActive = active;
}

export function isBenchmarkActive(): boolean {
  return benchmarkActive;
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

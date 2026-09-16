import { afterEach, describe, expect, it } from "@jest/globals";
import {
  BENCHMARK_LEASE_MS,
  getBenchmarkStatus,
  getRunningJobs,
  isBenchmarkActive,
  markJobFinished,
  markJobStarted,
  setBenchmarkActive,
  trackJob,
} from "../src/services/bench-mode.js";

afterEach(() => {
  setBenchmarkActive(false);
});

describe("benchmark flag", () => {
  it("toggles benchmark mode", () => {
    expect(isBenchmarkActive()).toBe(false);
    setBenchmarkActive(true);
    expect(isBenchmarkActive()).toBe(true);
    setBenchmarkActive(false);
    expect(isBenchmarkActive()).toBe(false);
  });

  it("expires 15 minutes after the last start, so a crashed benchmark can't pause jobs forever", () => {
    const start = 1_000_000;
    expect(BENCHMARK_LEASE_MS).toBe(15 * 60 * 1000);
    setBenchmarkActive(true, start);
    expect(isBenchmarkActive(start + BENCHMARK_LEASE_MS - 1)).toBe(true);
    expect(isBenchmarkActive(start + BENCHMARK_LEASE_MS)).toBe(false);
    // Expiry clears the lease rather than just hiding it
    expect(isBenchmarkActive(start)).toBe(false);
  });

  it("refreshes the lease when started again", () => {
    const start = 1_000_000;
    setBenchmarkActive(true, start);
    setBenchmarkActive(true, start + 10 * 60 * 1000);
    expect(isBenchmarkActive(start + BENCHMARK_LEASE_MS + 1)).toBe(true);
  });

  it("reports the lease expiry", () => {
    const start = Date.UTC(2026, 8, 16, 12, 0, 0);
    expect(getBenchmarkStatus(start)).toEqual({ active: false, expiresAt: null });
    setBenchmarkActive(true, start);
    expect(getBenchmarkStatus(start)).toEqual({ active: true, expiresAt: "2026-09-16T12:15:00.000Z" });
  });
});

describe("job tracking", () => {
  it("reports a job while it runs and clears it afterwards", async () => {
    let seenDuringRun: string[] = [];
    await trackJob("news-agent", async () => {
      seenDuringRun = getRunningJobs();
    });
    expect(seenDuringRun).toEqual(["news-agent"]);
    expect(getRunningJobs()).toEqual([]);
  });

  it("clears a job that throws", async () => {
    await expect(trackJob("gap-detection", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(getRunningJobs()).toEqual([]);
  });

  it("counts overlapping runs of the same job", () => {
    markJobStarted("graph-extraction");
    markJobStarted("graph-extraction");
    markJobFinished("graph-extraction");
    expect(getRunningJobs()).toEqual(["graph-extraction"]);
    markJobFinished("graph-extraction");
    expect(getRunningJobs()).toEqual([]);
  });
});

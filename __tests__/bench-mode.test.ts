import { afterEach, describe, expect, it } from "@jest/globals";
import {
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

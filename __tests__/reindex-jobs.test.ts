import { describe, expect, it } from "@jest/globals";
import { createReindexJobs } from "../src/services/reindex-jobs.js";
import type { ReindexProgress, ReindexResult } from "../src/services/reindex.js";

const result: ReindexResult = {
  stack: "ollama",
  knowledgeFiles: 40,
  rawDocuments: 7023,
  memoryChunks: 7626,
  chromaChunks: 7289,
  skippedRawDocuments: 0,
  seconds: 947.1,
};

interface Deferred {
  promise: Promise<ReindexResult>;
  resolve: (value: ReindexResult) => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (value: ReindexResult) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<ReindexResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixedClock(): () => Date {
  const times = ["2026-09-17T10:00:00.000Z", "2026-09-17T10:15:47.000Z"];
  return () => new Date(times.shift() ?? "2026-09-17T23:59:59.000Z");
}

describe("createReindexJobs", () => {
  it("starts idle", () => {
    const jobs = createReindexJobs(() => deferred().promise);
    expect(jobs.status()).toEqual({ job_id: null, status: "idle" });
    expect(jobs.isRunning()).toBe(false);
  });

  it("tracks a running job, its progress and its result", async () => {
    const run = deferred();
    let report: (progress: ReindexProgress) => void = () => {};
    const jobs = createReindexJobs(
      (onProgress) => {
        report = onProgress;
        return run.promise;
      },
      fixedClock(),
      () => "job-1"
    );

    expect(jobs.start()).toEqual({ job_id: "job-1" });
    expect(jobs.isRunning()).toBe(true);
    report({ rawDocumentsDone: 64, rawDocumentsTotal: 7023 });
    expect(jobs.status()).toEqual({
      job_id: "job-1",
      status: "running",
      started_at: "2026-09-17T10:00:00.000Z",
      progress: { raw_documents_done: 64, raw_documents_total: 7023 },
    });

    run.resolve(result);
    await jobs.wait();

    expect(jobs.status()).toMatchObject({
      job_id: "job-1",
      status: "succeeded",
      finished_at: "2026-09-17T10:15:47.000Z",
      result,
    });
    expect(jobs.isRunning()).toBe(false);
  });

  it("records a failure", async () => {
    const run = deferred();
    const jobs = createReindexJobs(() => run.promise, fixedClock(), () => "job-2");

    jobs.start();
    run.reject(new Error("OLLAMA stack not reachable"));
    await jobs.wait();

    expect(jobs.status()).toMatchObject({ job_id: "job-2", status: "failed", error: "OLLAMA stack not reachable" });
  });

  it("refuses to start a second job while one is running", () => {
    const jobs = createReindexJobs(() => deferred().promise);
    jobs.start();
    expect(() => jobs.start()).toThrow("A reindex is already running");
  });
});

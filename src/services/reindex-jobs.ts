// In-memory tracking of background reindex jobs started through the API

import { randomUUID } from "node:crypto";
import type { ReindexProgress, ReindexResult } from "./reindex.js";

export interface ReindexJobStatus {
  job_id: string | null;
  status: "idle" | "running" | "succeeded" | "failed";
  started_at?: string;
  finished_at?: string;
  progress?: { raw_documents_done: number; raw_documents_total: number };
  result?: ReindexResult;
  error?: string;
}

export interface ReindexRunner {
  (onProgress: (progress: ReindexProgress) => void): Promise<ReindexResult>;
}

export interface ReindexJobs {
  start(): { job_id: string };
  status(): ReindexJobStatus;
  isRunning(): boolean;
  wait(): Promise<void>;
}

// Only the most recent job is kept; the index completeness markers remain the source of truth after a restart
export function createReindexJobs(
  runner: ReindexRunner,
  now: () => Date = () => new Date(),
  newId: () => string = randomUUID
): ReindexJobs {
  let current: ReindexJobStatus = { job_id: null, status: "idle" };
  let pending: Promise<void> = Promise.resolve();

  return {
    start() {
      if (current.status === "running") throw new Error("A reindex is already running");

      const jobId = newId();
      current = { job_id: jobId, status: "running", started_at: now().toISOString() };

      pending = runner((progress) => {
        if (current.job_id !== jobId) return;
        current = {
          ...current,
          progress: { raw_documents_done: progress.rawDocumentsDone, raw_documents_total: progress.rawDocumentsTotal },
        };
      })
        .then((result) => {
          current = { ...current, status: "succeeded", finished_at: now().toISOString(), result };
        })
        .catch((err: unknown) => {
          current = {
            ...current,
            status: "failed",
            finished_at: now().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          };
        });

      return { job_id: jobId };
    },
    status: () => current,
    isRunning: () => current.status === "running",
    wait: () => pending,
  };
}

// Retention for finished exports.
//
// An export that has been delivered to `download` leaves its bytes in
// data/exports/ so the job's URL can serve them. Nothing used to remove them,
// so every artifact ever produced stayed on disk and stayed servable -- and
// since every export now writes a distinct file (they are addressed by job id),
// that set only grows.
//
// R1: the file goes, the job row stays. The row is a few hundred bytes and
// keeps `GET /api/export/:id` honest: a caller polling an old job learns the
// export EXPIRED rather than receiving the 404 of an id that never existed.
// It also leaves a record of what was produced, which the files alone would
// not give once deleted.
//
// R2: this owns data/exports/ and nothing else. An `icloud` export was
// deliberately delivered into the user's iCloud-synced Documents folder, so
// deleting it would also remove it from their other devices; a `telegram`
// export has already left the machine entirely and has no local file to sweep.
// Both are the user's to manage. Only the download directory -- which exists
// solely to back a job URL -- is ours.

import type { ExportJob, ExportJobStore } from "./export-jobs.js";
import { downloadFilename } from "./export-pipeline.js";
import { resolveContainedPath } from "./export-delivery.js";

// Chosen with the user on 2026-09-22: long enough that a shared link survives
// a month, short enough that internal artifacts are not kept indefinitely.
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  jobs: ExportJobStore;
  downloadDir: string;
  now: Date;
  unlink(path: string): Promise<void>;
}

function isGone(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Delete the stored file of every `download` export older than the retention
 * window, and mark its job expired. Safe to call repeatedly: an already-expired
 * job is no longer `done`, so it is not selected again.
 */
export async function sweepExpiredExports(deps: RetentionDeps): Promise<number> {
  const cutoff = new Date(deps.now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  const expired: ExportJob[] = deps.jobs.listExpirable(cutoff);

  let swept = 0;
  for (const job of expired) {
    const path = resolveContainedPath(deps.downloadDir, downloadFilename(job));
    // Refuses to resolve only if the id could address something outside the
    // download directory. Nothing is deleted in that case — a sweep must never
    // be the thing that reaches outside its own folder.
    if (path === null) continue;
    try {
      await deps.unlink(path);
    } catch (err) {
      // A file already removed by hand must not wedge the sweep or leave the
      // row advertising a download that cannot be served. Anything else --
      // a permissions problem, a busy volume -- is left for the next sweep
      // rather than silently marking the bytes gone when they are not.
      if (!isGone(err)) continue;
    }
    deps.jobs.expire(job.id);
    swept += 1;
  }
  return swept;
}

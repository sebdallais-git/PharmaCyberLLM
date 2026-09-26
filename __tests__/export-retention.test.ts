import { describe, expect, it } from "@jest/globals";
import { openExportJobs } from "../src/services/export-jobs.js";
import type { ExportJobStore, ExportRequest } from "../src/services/export-jobs.js";
import { RETENTION_DAYS, sweepExpiredExports } from "../src/services/export-retention.js";

const request: ExportRequest = {
  kind: "account-brief",
  format: "pdf",
  audience: "internal",
  destination: "download",
  account: "roche",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-22T10:00:00.000Z");

// A store plus a record of what the sweep deleted. `unlink` is injected so no
// test ever removes a real file, and the store is :memory: so none opens the
// live job database. The clock is injected too: retention acts on AGE, and the
// only honest way to have an old job is to have created it long ago.
interface Harness {
  jobs: ExportJobStore;
  deleted: string[];
  missing: Set<string>;
  /** Creates a job stamped `days` ago, exactly as the store would have then. */
  aged(days: number, over?: Partial<ExportRequest>): string;
}

function harness(): Harness {
  let clock = NOW;
  const jobs = openExportJobs(":memory:", () => clock);
  const h: Harness = {
    jobs,
    deleted: [],
    missing: new Set<string>(),
    aged(days: number, over: Partial<ExportRequest> = {}): string {
      clock = new Date(NOW.getTime() - days * DAY_MS);
      const id = jobs.create({ ...request, ...over });
      clock = NOW;
      return id;
    },
  };
  return h;
}

function deps(h: Harness) {
  return {
    jobs: h.jobs,
    downloadDir: "/tmp/exports",
    now: NOW,
    async unlink(path: string): Promise<void> {
      if (h.missing.has(path)) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
        err.code = "ENOENT";
        throw err;
      }
      h.deleted.push(path);
    },
  };
}

describe("sweepExpiredExports", () => {
  it("deletes the file of a download export older than the retention window", async () => {
    const h = harness();
    const id = h.aged(RETENTION_DAYS + 1);
    h.jobs.complete(id, `/api/export/file/${id}`);

    await sweepExpiredExports(deps(h));

    expect(h.deleted).toEqual([`/tmp/exports/${id}.pdf`]);
    h.jobs.close();
  });

  it("keeps the job row and reports the export as expired", async () => {
    const h = harness();
    const id = h.aged(RETENTION_DAYS + 1);
    h.jobs.complete(id, `/api/export/file/${id}`);

    await sweepExpiredExports(deps(h));

    // The row survives on purpose: a caller polling the job learns the export
    // expired rather than getting the 404 of an id that never existed.
    expect(h.jobs.get(id)?.stage).toBe("expired");
    h.jobs.close();
  });

  it("leaves an export inside the retention window alone", async () => {
    const h = harness();
    const id = h.aged(RETENTION_DAYS - 1);
    h.jobs.complete(id, `/api/export/file/${id}`);

    await sweepExpiredExports(deps(h));

    expect(h.deleted).toEqual([]);
    expect(h.jobs.get(id)?.stage).toBe("done");
    h.jobs.close();
  });

  it("never touches an icloud or telegram export, however old", async () => {
    const h = harness();
    for (const destination of ["icloud", "telegram"] as const) {
      const id = h.aged(RETENTION_DAYS * 10, { destination });
      h.jobs.complete(id, destination === "telegram" ? "telegram" : "/Users/x/Documents/a.pdf");
    }

    await sweepExpiredExports(deps(h));

    // Retention owns data/exports/ only. An icloud file was deliberately
    // delivered to the user and lives in their synced Documents folder;
    // deleting it would also remove it from their other devices.
    expect(h.deleted).toEqual([]);
    h.jobs.close();
  });

  it("leaves an unfinished or failed job alone", async () => {
    const h = harness();
    const queued = h.aged(RETENTION_DAYS + 1);
    const failed = h.aged(RETENTION_DAYS + 1);
    h.jobs.fail(failed, "narrating", "model unreachable");

    await sweepExpiredExports(deps(h));

    expect(h.deleted).toEqual([]);
    expect(h.jobs.get(queued)?.stage).toBe("queued");
    expect(h.jobs.get(failed)?.stage).toBe("failed");
    h.jobs.close();
  });

  it("expires a job whose file is already gone", async () => {
    const h = harness();
    const id = h.aged(RETENTION_DAYS + 1);
    h.jobs.complete(id, `/api/export/file/${id}`);
    h.missing.add(`/tmp/exports/${id}.pdf`);

    await sweepExpiredExports(deps(h));

    // A file deleted by hand must not wedge the sweep or leave the row
    // claiming a download that cannot be served.
    expect(h.jobs.get(id)?.stage).toBe("expired");
    h.jobs.close();
  });

  it("sweeps every expired export, not just the first", async () => {
    const h = harness();
    const ids = [h.aged(RETENTION_DAYS + 1), h.aged(RETENTION_DAYS + 2), h.aged(RETENTION_DAYS + 3)];
    for (const id of ids) h.jobs.complete(id, `/api/export/file/${id}`);

    await sweepExpiredExports(deps(h));

    expect(h.deleted).toHaveLength(3);
    expect(ids.every((id) => h.jobs.get(id)?.stage === "expired")).toBe(true);
    h.jobs.close();
  });

  it("is idempotent — a second sweep deletes nothing more", async () => {
    const h = harness();
    const id = h.aged(RETENTION_DAYS + 1);
    h.jobs.complete(id, `/api/export/file/${id}`);

    await sweepExpiredExports(deps(h));
    h.deleted.length = 0;
    await sweepExpiredExports(deps(h));

    expect(h.deleted).toEqual([]);
    h.jobs.close();
  });
});

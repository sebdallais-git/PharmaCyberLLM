import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExportRouter, createPipelineRunner, validateExportRequest } from "../src/api/export.js";
import type { ExportRouterDeps } from "../src/api/export.js";
import { openExportJobs } from "../src/services/export-jobs.js";
import type { ExportJobStore } from "../src/services/export-jobs.js";

const good = {
  kind: "account-brief",
  format: "pdf",
  audience: "internal",
  destination: "telegram",
  account: "roche",
};

describe("validateExportRequest", () => {
  it("accepts a complete request", () => {
    const result = validateExportRequest(good);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe("telegram");
  });

  it("defaults the destination to download", () => {
    const { destination: _drop, ...noDestination } = good;
    const result = validateExportRequest(noDestination);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe("download");
  });

  // No default: an export that does not say who it is for must not guess,
  // because the two audiences contain different data.
  it("rejects a request with no audience", () => {
    const { audience: _drop, ...noAudience } = good;
    const result = validateExportRequest(noAudience);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/audience/i);
  });

  it("rejects an unknown format", () => {
    const result = validateExportRequest({ ...good, format: "keynote" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/format/i);
  });

  it("rejects an unknown artifact kind", () => {
    const result = validateExportRequest({ ...good, kind: "sales-forecast" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kind/i);
  });

  it("rejects a non-object body", () => {
    expect(validateExportRequest(null).ok).toBe(false);
    expect(validateExportRequest("hello").ok).toBe(false);
    expect(validateExportRequest(undefined).ok).toBe(false);
  });
});

// Router-level tests. Every dependency is injected -- an in-memory job store
// and a fake pipeline runner -- so no test here opens the real job database
// or starts the real narrate/render/deliver pipeline.
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
});

interface Fixture {
  url: string;
  jobs: ExportJobStore;
  started: string[];
  downloadDir: string;
}

function startApp(overrides: Partial<ExportRouterDeps> = {}): Promise<Fixture> {
  const jobs = openExportJobs(":memory:");
  const downloadDir = mkdtempSync(join(tmpdir(), "export-route-test-"));
  const started: string[] = [];
  const deps: ExportRouterDeps = {
    jobs,
    downloadDir,
    runPipeline: (jobId) => {
      started.push(jobId);
    },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use("/api/export", createExportRouter(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, jobs, started, downloadDir });
    });
  });
}

async function postExport(url: string, body: unknown) {
  const res = await fetch(`${url}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const goodRequest = {
  kind: "account-brief",
  format: "pdf",
  audience: "internal",
  account: "roche",
};

describe("POST /api/export", () => {
  it("creates a job, returns its id immediately, and starts the pipeline without waiting on it", async () => {
    const fixture = await startApp();

    const { status, body } = await postExport(fixture.url, goodRequest);

    expect(status).toBe(202);
    expect(typeof body.jobId).toBe("string");
    expect(fixture.jobs.get(body.jobId as string)?.stage).toBe("queued");
    expect(fixture.started).toEqual([body.jobId]);
  });

  it("does not wait for the pipeline to finish before responding", async () => {
    const resolvers: Array<() => void> = [];
    const gate = new Promise<void>((resolve) => resolvers.push(resolve));
    let pipelineFinished = false;
    const fixture = await startApp({
      runPipeline: () => {
        void gate.then(() => {
          pipelineFinished = true;
        });
      },
    });

    const { status } = await postExport(fixture.url, goodRequest);

    expect(status).toBe(202);
    expect(pipelineFinished).toBe(false);
    resolvers[0]?.();
  });

  it("rejects an invalid request with 400 and creates no job", async () => {
    const fixture = await startApp();

    const { status, body } = await postExport(fixture.url, { ...goodRequest, audience: undefined });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/audience/i);
    expect(fixture.started).toEqual([]);
  });
});

describe("GET /api/export/:id", () => {
  it("reports the job's stage while it is running", async () => {
    const fixture = await startApp();
    const id = fixture.jobs.create({ kind: "account-brief", format: "pdf", audience: "internal", destination: "download", account: "roche" });
    fixture.jobs.setStage(id, "narrating");

    const res = await fetch(`${fixture.url}/api/export/${id}`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.stage).toBe("narrating");
  });

  it("returns 404 for an unknown job id", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/export/does-not-exist`);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/export/file/:filename", () => {
  it("serves a normal file from the download directory", async () => {
    const fixture = await startApp();
    writeFileSync(join(fixture.downloadDir, "roche-brief.pdf"), "hello pdf");

    const res = await fetch(`${fixture.url}/api/export/file/roche-brief.pdf`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toBe("hello pdf");
  });

  // The read-side mirror of export-delivery.ts's write-side containment
  // check: a bare regex-strip of disallowed characters leaves ".." intact
  // (dots are inside [a-z0-9._-]), so this must be refused by path
  // resolution and containment, not by character stripping alone. The dots
  // are percent-encoded so the HTTP client does not normalise them away
  // before the request even leaves the process.
  it("refuses a filename containing ..", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/export/file/%2E%2E`);

    expect([400, 404]).toContain(res.status);
  });

  // "%2F" decodes (by Express's param decoding) to a bare "/", whose
  // basename() is "". path.resolve(dir, "") collapses back to dir itself,
  // which a guard that only checks resolvedPath !== resolvedDir would miss.
  it("refuses a filename that sanitises to empty", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/export/file/%2F`);

    expect([400, 404]).toContain(res.status);
  });

  it("does not let a filename containing a path separator escape the download directory", async () => {
    const fixture = await startApp();
    // A sibling file outside downloadDir that must never be reachable
    const outsideDir = mkdtempSync(join(tmpdir(), "export-route-outside-"));
    writeFileSync(join(outsideDir, "secret.pdf"), "top secret");
    const escaping = encodeURIComponent(`${outsideDir}/secret.pdf`);

    const res = await fetch(`${fixture.url}/api/export/file/${escaping}`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("top secret");
  });

  it("returns 404 for a filename that does not exist", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/export/file/nope.pdf`);

    expect(res.status).toBe(404);
  });
});

// createPipelineRunner is the fix for the finding in
// .superpowers/sdd/2026-09-22-artifact-export/task-9-fix-1.md: the catch
// on the un-awaited pipeline promise must not just console.error -- it
// must fail the job so a poller can see why an export never arrived. This
// only fires for a rejection BEFORE runExport's own total try/catch, i.e.
// buildPipelineDeps() itself (in production: Neo4j / the watchlist store
// being unreachable), which is exactly what these fakes simulate. No test
// here touches a live service: buildPipelineDeps and runExport are both
// fakes, and jobs is the same in-memory store the route reads back from.
describe("createPipelineRunner", () => {
  it("fails the job with a stage and message when the pipeline runner rejects, readable through the status route", async () => {
    const jobs = openExportJobs(":memory:");
    const runner = createPipelineRunner({
      jobs,
      buildPipelineDeps: async () => {
        throw new Error("Neo4j is not running");
      },
      runExport: async () => {},
    });
    let pending: Promise<void> | undefined;
    const fixture = await startApp({
      jobs,
      runPipeline: (jobId) => {
        pending = runner(jobId);
      },
    });

    const { status, body } = await postExport(fixture.url, goodRequest);
    expect(status).toBe(202);
    await pending;

    const res = await fetch(`${fixture.url}/api/export/${body.jobId as string}`);
    const job = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(job.stage).toBe("failed");
    // "queued" because the job never started gathering -- that is the
    // honest stage to report, not a guess at where it would have gotten to.
    expect(String(job.error)).toMatch(/queued/);
    expect(String(job.error)).toMatch(/Neo4j is not running/);
  });

  it("returns the job id immediately -- the failure is only recorded after the response was already sent", async () => {
    let rejectGate!: (err: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => {
      rejectGate = reject;
    });
    const jobs = openExportJobs(":memory:");
    const runner = createPipelineRunner({
      jobs,
      buildPipelineDeps: () => gate,
      runExport: async () => {},
    });
    let pending: Promise<void> | undefined;
    const fixture = await startApp({
      jobs,
      runPipeline: (jobId) => {
        pending = runner(jobId);
      },
    });

    const { status, body } = await postExport(fixture.url, goodRequest);
    expect(status).toBe(202);
    expect(typeof body.jobId).toBe("string");

    // The response is already sent; the job must still be at "queued"
    // because the pipeline wiring has not settled (rejected or not) yet.
    const queuedRes = await fetch(`${fixture.url}/api/export/${body.jobId as string}`);
    const queuedJob = (await queuedRes.json()) as Record<string, unknown>;
    expect(queuedJob.stage).toBe("queued");

    rejectGate(new Error("Neo4j is not running"));
    await pending;

    const failedRes = await fetch(`${fixture.url}/api/export/${body.jobId as string}`);
    const failedJob = (await failedRes.json()) as Record<string, unknown>;
    expect(failedJob.stage).toBe("failed");
  });

  it("does not let a failure inside the fail() call become an unhandled rejection", async () => {
    // jobs.fail() throws when the id does not exist (export-jobs.ts). This
    // fake reproduces that throw unconditionally, standing in for any
    // reason fail() might throw, to prove the guard around it holds: the
    // runner must still settle (not reject) instead of letting this escape
    // as the unhandled rejection the original .catch() existed to prevent.
    const throwingJobs: ExportJobStore = {
      create: () => "job-1",
      get: () => null,
      setStage: () => {},
      complete: () => {},
      fail: () => {
        throw new Error('no export job with id "job-1"');
      },
      close: () => {},
    };
    const runner = createPipelineRunner({
      jobs: throwingJobs,
      buildPipelineDeps: async () => {
        throw new Error("Neo4j is not running");
      },
      runExport: async () => {},
    });

    await expect(runner("job-1")).resolves.toBeUndefined();
  });
});

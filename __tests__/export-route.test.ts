import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExportRouter, validateExportRequest } from "../src/api/export.js";
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

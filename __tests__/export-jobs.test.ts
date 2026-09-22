import { describe, expect, it } from "@jest/globals";
import { openExportJobs } from "../src/services/export-jobs.js";

const request = {
  kind: "account-brief" as const,
  format: "pdf" as const,
  audience: "internal" as const,
  destination: "download" as const,
};

describe("export jobs", () => {
  it("creates a queued job and reads it back", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    expect(jobs.get(id)?.stage).toBe("queued");
    jobs.close();
  });

  // Stages are recorded so a failure says WHICH step failed -- the LLM step
  // takes minutes, and "it failed" is not actionable.
  it("records the stage a job reached", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    jobs.setStage(id, "narrating");

    expect(jobs.get(id)?.stage).toBe("narrating");
    jobs.close();
  });

  it("stores the location on completion", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    jobs.complete(id, "/api/export/file/roche-brief.pdf");

    const job = jobs.get(id);
    expect(job?.stage).toBe("done");
    expect(job?.location).toBe("/api/export/file/roche-brief.pdf");
    jobs.close();
  });

  it("records which stage failed and why", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    jobs.fail(id, "narrating", "model unreachable");

    const job = jobs.get(id);
    expect(job?.stage).toBe("failed");
    expect(job?.error).toBe("narrating: model unreachable");
    jobs.close();
  });

  it("returns null for an unknown id rather than throwing", () => {
    const jobs = openExportJobs(":memory:");

    expect(jobs.get("nope")).toBeNull();
    jobs.close();
  });

  // Storage-boundary validation (R1): an unknown value in any closed
  // vocabulary must never reach a row, the same way insertItem in
  // watchlist-store.ts rejects an unknown domain or signal before writing.
  it("rejects a request with an unknown kind before writing a row", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.create({ ...request, kind: "not-a-kind" as never })).toThrow(/kind/);
    jobs.close();
  });

  it("rejects a request with an unknown format before writing a row", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.create({ ...request, format: "docx" as never })).toThrow(/format/);
    jobs.close();
  });

  it("rejects a request with an unknown audience before writing a row", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.create({ ...request, audience: "public" as never })).toThrow(/audience/);
    jobs.close();
  });

  it("rejects a request with an unknown destination before writing a row", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.create({ ...request, destination: "email" as never })).toThrow(/destination/);
    jobs.close();
  });

  it("rejects an unknown stage passed to setStage", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    expect(() => jobs.setStage(id, "reticulating" as never)).toThrow(/stage/);
    // The row must be untouched -- still queued, not corrupted mid-write.
    expect(jobs.get(id)?.stage).toBe("queued");
    jobs.close();
  });

  it("rejects an unknown stage passed to fail", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    expect(() => jobs.fail(id, "reticulating" as never, "boom")).toThrow(/stage/);
    expect(jobs.get(id)?.stage).toBe("queued");
    jobs.close();
  });

  // Final review, minor 2: setStage() used to be the odd sibling -- it
  // silently no-opped on an unknown id while complete() and fail() threw, so
  // a stale or mistyped id advanced nothing and said nothing.
  it("throws when setting the stage of an unknown job id", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.setStage("nope", "narrating")).toThrow(/nope/);
    jobs.close();
  });

  // complete() and fail() must not silently no-op on an unknown id: get()
  // already returns null for one, and a silent no-op would turn a wiring bug
  // (a stale or mistyped id) into a job that looks like a slow export forever.
  it("throws when completing an unknown job id", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.complete("nope", "/api/export/file/x.pdf")).toThrow(/nope/);
    jobs.close();
  });

  it("throws when failing an unknown job id", () => {
    const jobs = openExportJobs(":memory:");

    expect(() => jobs.fail("nope", "narrating", "boom")).toThrow(/nope/);
    jobs.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { sendJson } from "./helpers/fake-pharmaitchat.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return harness.client.callTool({ name, arguments: args });
}

describe("export tools", () => {
  it("requests an artifact and returns the job id PharmaITChat gave back", async () => {
    harness.pharma.on("POST", "/api/export", (_req, res) => sendJson(res, 202, { jobId: "job-1" }));

    const result = await call("create_artifact", {
      kind: "account-brief",
      format: "pdf",
      audience: "internal",
      destination: "telegram",
      account: "roche",
    });

    expect(JSON.parse(toolText(result))).toEqual({ jobId: "job-1" });
    expect(harness.pharma.requests[0].body).toEqual({
      kind: "account-brief",
      format: "pdf",
      audience: "internal",
      destination: "telegram",
      account: "roche",
    });
  });

  it("polls a job's status by id", async () => {
    harness.pharma.on("GET", "/api/export/job-1", (_req, res) =>
      sendJson(res, 200, { jobId: "job-1", stage: "rendering", location: null })
    );

    const result = await call("artifact_status", { job_id: "job-1" });

    expect(JSON.parse(toolText(result))).toEqual({ jobId: "job-1", stage: "rendering", location: null });
  });

  // A job id containing "/" or ".." must not be able to alter which route is
  // actually requested. encodeURIComponent turns "/" into "%2F", so the
  // fake server sees a single (undecoded) path segment, never a nested one.
  it("encodes a job id containing a slash so it cannot escape the status path", async () => {
    const trickyId = "../secret/path";
    const expectedPath = `/api/export/${encodeURIComponent(trickyId)}`;
    harness.pharma.on("GET", expectedPath, (_req, res) => sendJson(res, 200, { ok: true }));

    const result = await call("artifact_status", { job_id: trickyId });

    expect(harness.pharma.requests[0].path).toBe(expectedPath);
    expect(isToolError(result)).toBe(false);
  });

  it("rejects an empty job id before calling PharmaITChat", async () => {
    const result = await call("artifact_status", { job_id: "" });
    expect(isToolError(result)).toBe(true);
    expect(harness.pharma.requests).toHaveLength(0);
  });
});

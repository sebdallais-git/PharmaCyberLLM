import { describe, expect, it } from "@jest/globals";
import { runExport, type PipelineDeps } from "../src/services/export-pipeline.js";
import { openExportJobs } from "../src/services/export-jobs.js";
import type { Artifact } from "../src/services/artifact.js";

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  const artifact: Artifact = {
    title: "t", audience: "internal", generatedAt: "2026-09-22T10:00:00.000Z", sections: [], citations: [],
  };
  return {
    jobs: openExportJobs(":memory:"),
    async gather() {
      return artifact;
    },
    gatherDeps: {
      async incumbency() { return []; },
      async positions() { return []; },
      async news() { return []; },
    },
    async narrate(a) {
      return a;
    },
    render: {
      xlsx: async () => Buffer.from("x"),
      pdf: async () => Buffer.from("p"),
      pptx: async () => Buffer.from("k"),
    },
    async deliver() {
      return "/api/export/file/t.pdf";
    },
    deliveryDeps: {
      downloadDir: "/tmp/d",
      icloudDir: "/tmp/i",
      async writeFile() {},
      async sendDocument() {},
    },
    ...over,
  };
}

const request = {
  kind: "account-brief" as const,
  format: "pdf" as const,
  audience: "internal" as const,
  destination: "download" as const,
};

describe("runExport", () => {
  it("walks the job to done and records where the file went", async () => {
    const d = deps();
    const id = d.jobs.create(request);

    await runExport(id, d);

    const job = d.jobs.get(id);
    expect(job?.stage).toBe("done");
    expect(job?.location).toBe("/api/export/file/t.pdf");
    d.jobs.close();
  });

  // The LLM step takes minutes and is the one most likely to fail; the job must
  // say WHICH stage broke, not merely that it broke.
  it("records the failing stage when narration fails", async () => {
    const d = deps({
      async narrate() {
        throw new Error("model unreachable");
      },
    });
    const id = d.jobs.create(request);

    await runExport(id, d);

    expect(d.jobs.get(id)?.error).toBe("narrating: model unreachable");
    d.jobs.close();
  });

  it("does nothing for an unknown job id", async () => {
    const d = deps();

    await expect(runExport("nope", d)).resolves.toBeUndefined();
    d.jobs.close();
  });
});

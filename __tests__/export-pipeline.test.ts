import { describe, expect, it } from "@jest/globals";
import { runExport, type PipelineDeps } from "../src/services/export-pipeline.js";
import { openExportJobs, type ExportRequest } from "../src/services/export-jobs.js";
import { deliver } from "../src/services/export-delivery.js";
import { gather, type GatherDeps } from "../src/services/export-artifacts.js";
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

  it("records the failing stage and marks the job failed when gather fails", async () => {
    const d = deps({
      async gather() {
        throw new Error("network unreachable");
      },
    });
    const id = d.jobs.create(request);

    await runExport(id, d);

    const job = d.jobs.get(id);
    expect(job?.error).toBe("gathering: network unreachable");
    expect(job?.stage).toBe("failed");
    d.jobs.close();
  });

  it("records the failing stage when render fails", async () => {
    const d = deps({
      render: {
        xlsx: async () => Buffer.from("x"),
        pdf: async () => {
          throw new Error("disk full");
        },
        pptx: async () => Buffer.from("k"),
      },
    });
    const id = d.jobs.create(request);

    await runExport(id, d);

    expect(d.jobs.get(id)?.error).toBe("rendering: disk full");
    d.jobs.close();
  });

  it("records the failing stage when delivery fails", async () => {
    const d = deps({
      async deliver() {
        throw new Error("upload rejected");
      },
    });
    const id = d.jobs.create(request);

    await runExport(id, d);

    expect(d.jobs.get(id)?.error).toBe("delivering: upload rejected");
    d.jobs.close();
  });

  // Not a mirror of the tests above: this wires the REAL gather() from
  // export-artifacts.ts (with in-memory fake GatherDeps underneath) so the
  // throw the pipeline must catch comes from genuine collaborator code, not
  // from a hand-written throw in a test fake. vendor-comparison has no
  // external form and gather() throws by design for that combination.
  it("attributes a real gather() failure to the gathering stage", async () => {
    const fakeGatherDeps: GatherDeps = {
      async incumbency() {
        return [];
      },
      async positions() {
        return [];
      },
      async news() {
        return [];
      },
    };
    const d = deps({ gather, gatherDeps: fakeGatherDeps });
    const id = d.jobs.create({
      kind: "vendor-comparison",
      format: "pdf",
      audience: "external",
      destination: "download",
      vendor: "Acme",
    });

    await runExport(id, d);

    const job = d.jobs.get(id);
    expect(job?.error).toBe(
      "gathering: vendor-comparison is internal by nature; there is no external version",
    );
    expect(job?.stage).toBe("failed");
    d.jobs.close();
  });
});

// Critical finding of the whole-branch review: an internal and an external
// account-brief for the same account were given the same title, the delivered
// filename was derived from that title alone, and the download route served by
// filename. So an internal export silently overwrote the bytes behind a URL
// already handed to a customer -- and, for the iCloud destination, that
// overwrite left the machine.
//
// These tests drive the REAL gather() (so the titles are the ones production
// actually produces) and the REAL deliver() (so the assertion is on the path
// that reaches writeFile), with only the leaf I/O faked. Nothing here touches
// a live service: GatherDeps is a fake, the job store is ":memory:", and
// writeFile only records what it was asked to write.
function deliveryFixture(): { deps: PipelineDeps; written: Array<{ path: string; bytes: Buffer }> } {
  const written: Array<{ path: string; bytes: Buffer }> = [];
  const gatherDeps: GatherDeps = {
    async incumbency() {
      return [{ account: "roche", segment: "hpc", vendors: ["acme"] }];
    },
    async positions() {
      return [{ segment: "hpc", position: "defend", confidence: "high", rationale: "installed" }];
    },
    async news() {
      return [{ title: "AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
    },
  };
  return {
    written,
    deps: deps({
      gather,
      gatherDeps,
      deliver,
      deliveryDeps: {
        downloadDir: "/tmp/exports",
        icloudDir: "/tmp/icloud/PharmaITChat_Artifacts",
        async writeFile(path, bytes) {
          written.push({ path, bytes });
        },
        async sendDocument() {},
      },
    }),
  };
}

const brief = (over: Partial<ExportRequest>): ExportRequest => ({
  kind: "account-brief",
  format: "xlsx",
  audience: "internal",
  destination: "download",
  account: "roche",
  vendor: "acme",
  ...over,
});

describe("delivered paths never collide", () => {
  for (const destination of ["download", "icloud"] as const) {
    it(`gives an internal and an external ${destination} brief for the same account and format different paths`, async () => {
      const { deps: d, written } = deliveryFixture();
      const internal = d.jobs.create(brief({ destination, audience: "internal" }));
      const external = d.jobs.create(brief({ destination, audience: "external" }));

      await runExport(internal, d);
      await runExport(external, d);

      expect(d.jobs.get(internal)?.stage).toBe("done");
      expect(d.jobs.get(external)?.stage).toBe("done");
      expect(written).toHaveLength(2);
      expect(written[0].path).not.toBe(written[1].path);
      d.jobs.close();
    });
  }

  // Two requests that are identical in every field are still two different
  // exports of data that may have changed in between; neither may overwrite
  // the other's bytes.
  it("gives two identical requests different paths", async () => {
    const { deps: d, written } = deliveryFixture();
    const first = d.jobs.create(brief({}));
    const second = d.jobs.create(brief({}));

    await runExport(first, d);
    await runExport(second, d);

    expect(written[0].path).not.toBe(written[1].path);
    d.jobs.close();
  });

  // The iCloud folder is browsed by a human, so its filenames have to say what
  // they are -- above all which audience, since that is the difference between
  // a customer handout and an account-intelligence document.
  it("names the audience in the iCloud filename", async () => {
    const { deps: d, written } = deliveryFixture();
    const id = d.jobs.create(brief({ destination: "icloud", audience: "external" }));

    await runExport(id, d);

    expect(written[0].path.startsWith("/tmp/icloud/PharmaITChat_Artifacts/")).toBe(true);
    expect(written[0].path).toContain("external");
    expect(written[0].path).toContain(id);
    d.jobs.close();
  });

  // The location a caller polls for must address the JOB, not a filename the
  // caller could have named itself.
  it("records a download location that addresses the job", async () => {
    const { deps: d } = deliveryFixture();
    const id = d.jobs.create(brief({}));

    await runExport(id, d);

    expect(d.jobs.get(id)?.location).toBe(`/api/export/file/${id}`);
    d.jobs.close();
  });
});

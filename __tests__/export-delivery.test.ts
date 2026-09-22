import { describe, expect, it } from "@jest/globals";
import { deliver, isDestination, type DeliveryDeps } from "../src/services/export-delivery.js";

const file = { jobId: "job-1", filename: "roche-brief.pdf", bytes: Buffer.from("hello") };

function fakeDeps(): DeliveryDeps & { written: Array<{ path: string; bytes: Buffer }>; sent: string[] } {
  const written: Array<{ path: string; bytes: Buffer }> = [];
  const sent: string[] = [];
  return {
    written,
    sent,
    downloadDir: "/tmp/exports",
    icloudDir: "/tmp/icloud/PharmaITChat_Artifacts",
    async writeFile(path, bytes) {
      written.push({ path, bytes });
    },
    async sendDocument(filename) {
      sent.push(filename);
    },
  };
}

describe("isDestination", () => {
  it("accepts the three declared destinations and rejects others", () => {
    expect(isDestination("download")).toBe(true);
    expect(isDestination("telegram")).toBe(true);
    expect(isDestination("icloud")).toBe(true);
    expect(isDestination("email")).toBe(false);
  });
});

describe("deliver", () => {
  it("writes into the download directory and returns a url", async () => {
    const deps = fakeDeps();

    const where = await deliver(file, "download", deps);

    expect(deps.written[0].path).toBe("/tmp/exports/roche-brief.pdf");
    // The URL names the job, not the file: see export-pipeline.ts R8/R9.
    expect(where).toBe("/api/export/file/job-1");
  });

  it("writes into the iCloud artifacts folder", async () => {
    const deps = fakeDeps();

    const where = await deliver(file, "icloud", deps);

    expect(deps.written[0].path).toBe("/tmp/icloud/PharmaITChat_Artifacts/roche-brief.pdf");
    expect(where).toBe("/tmp/icloud/PharmaITChat_Artifacts/roche-brief.pdf");
  });

  it("sends the document through telegram", async () => {
    const deps = fakeDeps();

    const where = await deliver(file, "telegram", deps);

    expect(deps.sent).toEqual(["roche-brief.pdf"]);
    expect(where).toBe("telegram");
  });

  // RenderedFile.filename is derived upstream from a model-written artifact
  // title. A hostile or accidental "../../etc/evil.pdf" must not escape the
  // destination directory when written to disk.
  describe("path traversal", () => {
    it("strips parent-directory segments before writing to the download directory", async () => {
      const deps = fakeDeps();
      const hostile = { jobId: "job-1", filename: "../../../../etc/evil.pdf", bytes: Buffer.from("x") };

      await deliver(hostile, "download", deps);

      const writtenPath = deps.written[0].path;
      expect(writtenPath.startsWith("/tmp/exports/")).toBe(true);
      expect(writtenPath).not.toContain("..");
      expect(writtenPath).not.toContain("/etc/");
    });

    it("strips parent-directory segments before writing to the iCloud folder", async () => {
      const deps = fakeDeps();
      const hostile = { jobId: "job-1", filename: "../../../../etc/evil.pdf", bytes: Buffer.from("x") };

      await deliver(hostile, "icloud", deps);

      const writtenPath = deps.written[0].path;
      expect(writtenPath.startsWith("/tmp/icloud/PharmaITChat_Artifacts/")).toBe(true);
      expect(writtenPath).not.toContain("..");
      expect(writtenPath).not.toContain("/etc/");
    });

    it("strips embedded directory separators from an otherwise plain filename", async () => {
      const deps = fakeDeps();
      const hostile = { jobId: "job-1", filename: "sub/dir/evil.pdf", bytes: Buffer.from("x") };

      await deliver(hostile, "download", deps);

      expect(deps.written[0].path).toBe("/tmp/exports/evil.pdf");
    });
  });

  // A filename that sanitises down to nothing (or to "." or "..") must never
  // reach writeFile as the destination directory itself. path.resolve()
  // silently discards empty and "." segments, so resolve(dir, "") and
  // resolve(dir, ".") both equal `dir` — a guard that only checks
  // resolvedPath !== resolvedDir gets fooled by exactly these inputs.
  describe("degenerate filenames", () => {
    const destinations: Array<{ destination: "download" | "icloud"; dir: string }> = [
      { destination: "download", dir: "/tmp/exports" },
      { destination: "icloud", dir: "/tmp/icloud/PharmaITChat_Artifacts" },
    ];

    for (const { destination, dir } of destinations) {
      it(`rejects an empty filename for ${destination} instead of writing to the directory itself`, async () => {
        const deps = fakeDeps();
        const degenerate = { jobId: "job-1", filename: "", bytes: Buffer.from("x") };

        await expect(deliver(degenerate, destination, deps)).rejects.toThrow();

        expect(deps.written.some((w) => w.path === dir)).toBe(false);
      });

      it(`rejects a "." filename for ${destination} instead of writing to the directory itself`, async () => {
        const deps = fakeDeps();
        const degenerate = { jobId: "job-1", filename: ".", bytes: Buffer.from("x") };

        await expect(deliver(degenerate, destination, deps)).rejects.toThrow();

        expect(deps.written.some((w) => w.path === dir)).toBe(false);
      });

      it(`rejects a ".." filename for ${destination} instead of writing to the directory itself`, async () => {
        const deps = fakeDeps();
        const degenerate = { jobId: "job-1", filename: "..", bytes: Buffer.from("x") };

        await expect(deliver(degenerate, destination, deps)).rejects.toThrow();

        expect(deps.written.some((w) => w.path === dir)).toBe(false);
      });

      it(`writes a "..." filename for ${destination} to a real child path, not the directory itself`, async () => {
        // Three dots have no special meaning to the filesystem (unlike "."
        // or ".."), so this is a legitimate — if odd — filename and must be
        // accepted, landing strictly inside the destination directory.
        const deps = fakeDeps();
        const dotsOnly = { jobId: "job-1", filename: "...", bytes: Buffer.from("x") };

        await deliver(dotsOnly, destination, deps);

        expect(deps.written[0].path).toBe(`${dir}/...`);
        expect(deps.written[0].path).not.toBe(dir);
      });

      it(`rejects a filename made only of characters the sanitiser strips, for ${destination}, instead of writing to the directory itself`, async () => {
        const deps = fakeDeps();
        const strippedAway = { jobId: "job-1", filename: "///", bytes: Buffer.from("x") };

        await expect(deliver(strippedAway, destination, deps)).rejects.toThrow();

        expect(deps.written.some((w) => w.path === dir)).toBe(false);
      });
    }
  });
});

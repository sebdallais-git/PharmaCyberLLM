import { describe, expect, it } from "@jest/globals";
import { deliver, isDestination, type DeliveryDeps } from "../src/services/export-delivery.js";

const file = { filename: "roche-brief.pdf", bytes: Buffer.from("hello") };

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
    expect(where).toContain("/api/export/file/roche-brief.pdf");
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
      const hostile = { filename: "../../../../etc/evil.pdf", bytes: Buffer.from("x") };

      await deliver(hostile, "download", deps);

      const writtenPath = deps.written[0].path;
      expect(writtenPath.startsWith("/tmp/exports/")).toBe(true);
      expect(writtenPath).not.toContain("..");
      expect(writtenPath).not.toContain("/etc/");
    });

    it("strips parent-directory segments before writing to the iCloud folder", async () => {
      const deps = fakeDeps();
      const hostile = { filename: "../../../../etc/evil.pdf", bytes: Buffer.from("x") };

      await deliver(hostile, "icloud", deps);

      const writtenPath = deps.written[0].path;
      expect(writtenPath.startsWith("/tmp/icloud/PharmaITChat_Artifacts/")).toBe(true);
      expect(writtenPath).not.toContain("..");
      expect(writtenPath).not.toContain("/etc/");
    });

    it("strips embedded directory separators from an otherwise plain filename", async () => {
      const deps = fakeDeps();
      const hostile = { filename: "sub/dir/evil.pdf", bytes: Buffer.from("x") };

      await deliver(hostile, "download", deps);

      expect(deps.written[0].path).toBe("/tmp/exports/evil.pdf");
    });
  });
});

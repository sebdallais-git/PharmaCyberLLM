import { describe, expect, it } from "@jest/globals";
import { PDFDocument } from "pdf-lib";
import { renderPdf } from "../src/services/render-pdf.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — account brief",
  subtitle: "internal",
  audience: "internal",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "prose", heading: "Where Dell stands", body: "Dell holds storage-file.", cites: ["c1"] },
    { kind: "table", heading: "Incumbency", columns: ["segment", "vendor"], rows: [["storage-file", "dell"]] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("renderPdf", () => {
  it("produces a loadable PDF carrying the artifact title", async () => {
    const doc = await PDFDocument.load(await renderPdf(artifact));

    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Roche — account brief");
  });

  it("refuses an external artifact that carries internal content", async () => {
    const leaky: Artifact = { ...artifact, audience: "external" };

    await expect(renderPdf(leaky)).rejects.toThrow(/internal-only/i);
  });
});

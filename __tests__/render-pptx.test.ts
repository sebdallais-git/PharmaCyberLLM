import { describe, expect, it } from "@jest/globals";
import { buildPptx, renderPptx } from "../src/services/render-pptx.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — AI infrastructure",
  audience: "external",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "prose", heading: "Why now", body: "Roche is scaling its AI factory.", cites: ["c1"] },
    { kind: "table", heading: "Portfolio", columns: ["product", "use"], rows: [["PowerScale", "cryo-EM"]] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("renderPptx", () => {
  // A .pptx is a zip; its first bytes are the zip magic number. Asserting that
  // proves a real file was produced without unzipping it in a unit test.
  it("produces a pptx file", async () => {
    const buffer = await renderPptx(artifact);

    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 2).toString("binary")).toBe("PK");
  });

  it("produces a title slide plus one slide per section plus sources", async () => {
    // buildPptx returns the count so a test can assert layout without unzipping.
    const { slideCount } = await buildPptx(artifact);

    expect(slideCount).toBe(4);
  });

  it("refuses an external artifact that carries internal content", async () => {
    const leaky: Artifact = {
      ...artifact,
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    };

    await expect(renderPptx(leaky)).rejects.toThrow(/internal-only/i);
  });

  it("omits the sources slide when there are no citations", async () => {
    const noCitations: Artifact = { ...artifact, citations: [] };

    const { slideCount } = await buildPptx(noCitations);

    // Title slide + 2 section slides, no sources slide.
    expect(slideCount).toBe(3);
  });

  it("counts every section kind as its own slide, including chart and facts", async () => {
    const allKinds: Artifact = {
      title: "All section kinds",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [
        { kind: "prose", heading: "Prose", body: "Some body text.", cites: [] },
        { kind: "table", heading: "Table", columns: ["a"], rows: [["1"]] },
        { kind: "facts", heading: "Facts", items: [{ label: "l", value: "v" }] },
        { kind: "chart", heading: "Chart", spec: { type: "bar" } },
      ],
      citations: [],
    };

    const { slideCount } = await buildPptx(allKinds);

    // Title slide + 4 section slides, no sources slide.
    expect(slideCount).toBe(5);
  });

  it("produces only a title slide for an artifact with no sections and no citations", async () => {
    const bare: Artifact = {
      title: "Bare artifact",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [],
      citations: [],
    };

    const { slideCount } = await buildPptx(bare);

    expect(slideCount).toBe(1);
  });
});

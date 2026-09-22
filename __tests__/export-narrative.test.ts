import { describe, expect, it } from "@jest/globals";
import { narrateArtifact } from "../src/services/export-narrative.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — brief",
  audience: "external",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "table", heading: "Recent developments", columns: ["date", "headline"], rows: [["2026-09-20", "AI factory"]] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("narrateArtifact", () => {
  it("prepends a prose section written by the model", async () => {
    const result = await narrateArtifact(artifact, async () => "Roche is scaling its AI estate.");

    expect(result.sections[0]).toEqual({
      kind: "prose",
      heading: "Summary",
      body: "Roche is scaling its AI estate.",
      cites: ["c1"],
    });
  });

  it("keeps the original sections after the summary", async () => {
    const result = await narrateArtifact(artifact, async () => "text");

    expect(result.sections).toHaveLength(2);
    expect(result.sections[1].heading).toBe("Recent developments");
  });

  // The model must never be handed internal data for an external artifact; the
  // gatherer already omitted it, and this asserts the prompt reflects that.
  it("gives the model the artifact's own facts and nothing else", async () => {
    let seen = "";
    await narrateArtifact(artifact, async (prompt) => {
      seen = prompt;
      return "text";
    });

    expect(seen).toContain("AI factory");
    expect(seen).not.toContain("incumben");
  });

  it("returns the artifact unchanged when the model returns nothing", async () => {
    const result = await narrateArtifact(artifact, async () => "   ");

    expect(result.sections).toHaveLength(1);
  });
});

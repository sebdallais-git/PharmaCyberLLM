import { describe, expect, it } from "@jest/globals";
import { narrateArtifact } from "../src/services/export-narrative.js";
import { assertExternalSafe, type Artifact } from "../src/services/artifact.js";

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
  // gatherer already omitted it, and this asserts the prompt is built from the
  // artifact's own facts.
  it("gives the model the artifact's own facts and nothing else", async () => {
    let seen = "";
    await narrateArtifact(artifact, async (prompt) => {
      seen = prompt;
      return "text";
    });

    expect(seen).toContain("AI factory");
    // The prompt is exactly the artifact's sections plus the two framing
    // lines: nothing is added from anywhere else.
    expect(seen).toBe(
      [
        'Write a short summary for a document titled "Roche — brief".',
        "Audience: the customer.",
        "Use only the facts below. Do not invent figures, dates or product names.",
        "",
        "## Recent developments",
        "date | headline",
        "2026-09-20 | AI factory",
      ].join("\n"),
    );
  });

  // Final review, minor 4: this used to assert not.toContain("incumben") on
  // the PROMPT of a fixture that never contained the term, so it could not
  // fail. The real risk is the other direction -- the model writing internal
  // framing into an external artifact out of its own head, which no prompt
  // can prevent. narrateArtifact deliberately does not check (see its header
  // comment: the renderers' assertExternalSafe is the single backstop), so
  // what has to hold is that the narrated artifact is REJECTED by that
  // backstop rather than rendered.
  it("produces an artifact the external backstop rejects when the model writes internal framing", async () => {
    const narrated = await narrateArtifact(
      artifact,
      async () => "Roche is the incumbent's largest account, and we should defend it.",
    );

    expect(narrated.sections[0].kind).toBe("prose");
    expect(() => assertExternalSafe(narrated)).toThrow(/internal-only/i);
  });

  it("returns the artifact unchanged when the model returns nothing", async () => {
    const result = await narrateArtifact(artifact, async () => "   ");

    expect(result.sections).toHaveLength(1);
  });
});

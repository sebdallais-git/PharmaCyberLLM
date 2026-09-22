// The one step that calls the model. It sees only the artifact's own facts, so
// an external artifact cannot be narrated from internal data -- the gatherer
// (Task 6's gather()) already omitted anything internal-only for an external
// audience, and this function builds its prompt from the artifact it was
// given and nothing else. It does not call assertExternalSafe itself: every
// renderer already does (src/services/artifact.ts), and that check must stay
// the single backstop that trips at render time -- see export-pipeline.ts's
// ordering. Duplicating it here would only obscure which check actually
// caught a leak.
//
// Truncation: the `chat` function passed in is expected to REJECT (not
// resolve with partial text) when the model was cut off before finishing.
// See export-wiring.ts's buildNarrationChat for where that seam is built
// against the real LlmClient and why. narrateArtifact does nothing special
// to enforce this -- `await chat(prompt)` simply propagates that rejection to
// its own caller, which is exactly the behavior export-pipeline.ts's
// runExport needs: an unhandled throw during the "narrating" stage is
// recorded as that stage's failure, so a truncated summary fails the job
// instead of shipping a half sentence.
import type { Artifact } from "./artifact.js";

function factsAsText(artifact: Artifact): string {
  const lines: string[] = [];
  for (const section of artifact.sections) {
    lines.push(`## ${section.heading}`);
    if (section.kind === "table") {
      lines.push(section.columns.join(" | "));
      for (const row of section.rows) lines.push(row.join(" | "));
    }
    if (section.kind === "facts") for (const i of section.items) lines.push(`${i.label}: ${i.value}`);
    if (section.kind === "prose") lines.push(section.body);
  }
  return lines.join("\n");
}

export async function narrateArtifact(
  artifact: Artifact,
  chat: (prompt: string) => Promise<string>,
): Promise<Artifact> {
  const prompt = [
    `Write a short summary for a document titled "${artifact.title}".`,
    `Audience: ${artifact.audience === "external" ? "the customer" : "an internal account team"}.`,
    "Use only the facts below. Do not invent figures, dates or product names.",
    "",
    factsAsText(artifact),
  ].join("\n");

  const body = (await chat(prompt)).trim();
  if (body.length === 0) return artifact;

  return {
    ...artifact,
    sections: [
      { kind: "prose", heading: "Summary", body, cites: artifact.citations.map((c) => c.id) },
      ...artifact.sections,
    ],
  };
}

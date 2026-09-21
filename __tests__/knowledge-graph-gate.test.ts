import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";

// The gap-fill loop posts to /api/knowledge/ingest-text. That endpoint used to
// fire extractAndWriteEntities(), an LLM extraction that validated node labels
// but never relationship types -- how the previous graph reached 174 distinct
// types against 20 declared. The vendor graph is now built only from parsed
// frontmatter and declared install base, so this path must not write to it.
describe("the knowledge API does not write the old-schema graph", () => {
  const source = readFileSync("src/api/knowledge.ts", "utf8");

  it("no longer calls the free-text entity extractor", () => {
    expect(source).not.toMatch(/extractAndWriteEntities\s*\(/);
  });

  it("no longer imports the unvalidated graph writer", () => {
    expect(source).not.toMatch(/\bwriteEntities\b/);
  });
});

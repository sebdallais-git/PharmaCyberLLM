import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface WorkflowNode {
  name: string;
  parameters?: { jsCode?: string; url?: string };
}

const workflow = JSON.parse(
  readFileSync(join(process.cwd(), "n8n", "knowledge_gap_workflow_v2.json"), "utf8"),
) as { nodes: WorkflowNode[] };

function node(name: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

describe("knowledge gap workflow", () => {
  it("still posts the resolution check at the app, not the scorer", () => {
    expect(node("Check Gap Resolution").parameters?.url).toBe(
      "http://localhost:3000/api/knowledge/gaps/check-resolution",
    );
  });

  // The log node used to branch on a boolean. A three-way verdict read as a
  // boolean silently collapses "review" into "still open", which would spend
  // the retry the review band exists to save.
  it("logs the three-way verdict rather than a boolean", () => {
    const code = node("Resolution Result Log").parameters?.jsCode ?? "";

    expect(code).toContain("verdict");
    expect(code).toContain("gap_review");
    expect(code).toContain("probability");
  });
});

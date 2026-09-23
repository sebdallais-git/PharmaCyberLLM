import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStacks, STACK_NAMES } from "../src/config/llm-stacks.js";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("README stack documentation", () => {
  it("no longer claims there are three stacks", () => {
    expect(readme).not.toMatch(/Three interchangeable stacks/);
    expect(readme).toMatch(/Four interchangeable stacks/);
  });

  // Bare toContain(name)/toContain(port) checks are substring matches over a 961-line document:
  // "8000" and "mlx" pass for unrelated reasons anywhere in the file. This instead locates the
  // comparison table's header row (the one line that names every stack as "<name> stack") and its
  // Ports row, and checks each stack's name and port specifically there -- so a stack documented
  // only in prose, or a port that appears elsewhere in the file for an unrelated reason, fails it.
  it("documents every stack and its chat port in the comparison table", () => {
    const stacks = buildStacks({});
    const lines = readme.split("\n");
    const headerIndex = lines.findIndex(
      (line) => line.startsWith("|") && STACK_NAMES.every((name) => new RegExp(`${name}\\s+stack`, "i").test(line))
    );
    expect(headerIndex).toBeGreaterThan(-1);
    const header = lines[headerIndex];
    const portsRow = lines.slice(headerIndex).find((line) => /\*\*Ports\*\*/.test(line));
    expect(portsRow).toBeDefined();

    for (const name of STACK_NAMES) {
      expect(header).toMatch(new RegExp(`${name}\\s+stack`, "i"));
      const port = new URL(stacks[name].chatBaseUrl).port || "11434";
      expect(portsRow).toContain(`:${port}`);
    }
  });
});

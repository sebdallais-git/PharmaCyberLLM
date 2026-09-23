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

  it("documents every stack and its chat port", () => {
    const stacks = buildStacks({});
    for (const name of STACK_NAMES) {
      expect(readme).toContain(name);
      expect(readme).toContain(new URL(stacks[name].chatBaseUrl).port || "11434");
    }
  });
});

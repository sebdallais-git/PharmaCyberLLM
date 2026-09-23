import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STACK_NAMES } from "../src/config/llm-stacks.js";

describe("graph rebuild is Ollama-only", () => {
  // Guards against a future rewrite into an allowlist, which would silently
  // start permitting whichever stacks someone remembered to list.
  it("refuses by a negative check on ollama, not an allowlist", () => {
    const src = readFileSync(join(process.cwd(), "src", "api", "graph.ts"), "utf8");

    expect(src).toMatch(/getActiveStack\(\)\.name !== "ollama"/);
    for (const stack of STACK_NAMES.filter((s) => s !== "ollama")) {
      expect(src).not.toMatch(new RegExp(`name === "${stack}"`));
    }
  });
});

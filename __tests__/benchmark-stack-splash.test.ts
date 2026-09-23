import { describe, expect, it } from "@jest/globals";
import { stackPatterns } from "../scripts/benchmark-stack.js";
import { STACK_NAMES } from "../src/config/llm-stacks.js";

describe("benchmark process sampling", () => {
  // stackPatterns picks the pgrep patterns used to sample memory. Its default
  // arm returns Ollama's, so an unhandled stack does not error -- it silently
  // measures the wrong process and writes a plausible, wrong number into the
  // benchmark row this change exists to compare.
  it("has patterns for splash that are not Ollama's", () => {
    expect(stackPatterns("splash")).not.toEqual(stackPatterns("ollama"));
    expect(stackPatterns("splash").join(" ")).toMatch(/splash/i);
  });

  it("has distinct patterns for every stack", () => {
    const joined = STACK_NAMES.map((s) => stackPatterns(s).join("|"));

    expect(new Set(joined).size).toBe(STACK_NAMES.length);
  });
});

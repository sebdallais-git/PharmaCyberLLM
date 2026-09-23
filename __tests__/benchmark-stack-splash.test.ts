import { describe, expect, it } from "@jest/globals";
import { stackPatterns } from "../scripts/benchmark-stack.js";
import { buildStacks, STACK_NAMES } from "../src/config/llm-stacks.js";

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

  // IMPORTANT 1: sampleMemory sums RSS across a stack's patterns. Any stack whose embedBaseUrl
  // differs from its chatBaseUrl runs a separate embedding process -- and if that process is the
  // MLX embedding server (the arrangement splash and omlx-alikes use), mlx's own arm already
  // charges "mlx-embed-server.py" to mlx. Omitting the pattern from the borrowing stack silently
  // undercounts it, biasing the comparison this benchmark exists to produce. Derived from
  // buildStacks() rather than hardcoding "splash", so a fifth stack in the same shape is covered
  // without touching this test.
  it("includes the MLX embedding server's pattern for every stack that borrows it", () => {
    const stacks = buildStacks({});
    const mlxEmbedPattern = "mlx-embed-server.py";
    expect(stackPatterns("mlx")).toContain(mlxEmbedPattern);

    for (const stack of Object.values(stacks)) {
      if (stack.name !== "mlx" && stack.embedBaseUrl === stacks.mlx.embedBaseUrl) {
        expect(stackPatterns(stack.name)).toContain(mlxEmbedPattern);
      }
    }
  });
});

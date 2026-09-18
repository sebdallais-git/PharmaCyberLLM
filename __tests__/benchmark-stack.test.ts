import { beforeAll, describe, expect, it } from "@jest/globals";

// benchmark-stack.ts reads an API token at import time; set it via env so the module
// never touches data/run/api-token (that file belongs to the live running app).
let stackPatterns: (stack: string) => string[];

beforeAll(async () => {
  process.env.PHARMALLM_API_TOKEN = "test-token";
  ({ stackPatterns } = await import("../scripts/benchmark-stack.js"));
});

describe("benchmark-stack.ts stackPatterns", () => {
  it("picks the right process patterns for all three stacks", () => {
    expect(stackPatterns("ollama")).toEqual(["ollama serve", "lib/ollama/llama-server", "ollama runner"]);
    expect(stackPatterns("mlx")).toEqual(["mlx_lm.server", "mlx-embed-server.py"]);
    // Regression check: omlx must not silently fall back to Ollama's patterns (0 MB sampled)
    expect(stackPatterns("omlx")).toEqual(["omlx-server", "omlx serve"]);
  });
});

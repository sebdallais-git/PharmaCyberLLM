import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

// benchmark-stack.ts reads an API token at import time; set it via env so the module
// never touches data/run/api-token (that file belongs to the live running app).
let stackPatterns: (stack: string) => string[];
let collectPids: (patterns: string[], pgrep?: (pattern: string) => string) => Set<string>;

const previousToken = process.env.PHARMALLM_API_TOKEN;

beforeAll(async () => {
  process.env.PHARMALLM_API_TOKEN = "test-token";
  ({ stackPatterns, collectPids } = await import("../scripts/benchmark-stack.js"));
});

afterAll(() => {
  // jest workers share process.env across test files — don't leak this into another suite
  if (previousToken === undefined) delete process.env.PHARMALLM_API_TOKEN;
  else process.env.PHARMALLM_API_TOKEN = previousToken;
});

describe("benchmark-stack.ts stackPatterns", () => {
  it("picks the right process patterns for all three stacks", () => {
    expect(stackPatterns("ollama")).toEqual(["ollama serve", "lib/ollama/llama-server", "ollama runner"]);
    expect(stackPatterns("mlx")).toEqual(["mlx_lm.server", "mlx-embed-server.py"]);
    // Regression check: omlx must not silently fall back to Ollama's patterns (0 MB sampled)
    expect(stackPatterns("omlx")).toEqual(["omlx-server", "omlx serve"]);
  });
});

describe("benchmark-stack.ts collectPids", () => {
  it("deduplicates a process matched by more than one pattern", () => {
    // omlx's single server process matches both "omlx-server" and "omlx serve" — pgrep would
    // return the same PID for each, and summing ps rss per pattern would double-count it.
    const pgrep = (pattern: string): string => (pattern === "omlx-server" || pattern === "omlx serve" ? "4242" : "");
    const pids = collectPids(["omlx-server", "omlx serve"], pgrep);
    expect(pids).toEqual(new Set(["4242"]));
  });

  it("keeps distinct PIDs from different patterns", () => {
    const pgrep = (pattern: string): string => (pattern === "mlx_lm.server" ? "100" : pattern === "mlx-embed-server.py" ? "200" : "");
    const pids = collectPids(["mlx_lm.server", "mlx-embed-server.py"], pgrep);
    expect(pids).toEqual(new Set(["100", "200"]));
  });

  it("ignores non-numeric pgrep noise", () => {
    const pgrep = (): string => "not-a-pid\n123\n";
    expect(collectPids(["anything"], pgrep)).toEqual(new Set(["123"]));
  });
});

import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStacks } from "../src/config/llm-stacks.js";

const script = readFileSync(join(process.cwd(), "scripts", "switch-stack.sh"), "utf-8");
const modelfile = readFileSync(join(process.cwd(), "ollama", "qwen3.8-pharma.Modelfile"), "utf-8");

function shellVar(name: string): string {
  const match = script.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${name} not found in switch-stack.sh`);
  return match[1];
}

describe("switch-stack.sh stays in sync with llm-stacks.ts", () => {
  const { ollama, mlx } = buildStacks({});

  it("uses the same model names", () => {
    expect(shellVar("OLLAMA_CHAT_MODEL")).toBe(ollama.chatModel);
    expect(shellVar("OLLAMA_EMBED_MODEL")).toBe(ollama.embeddingModel);
    expect(shellVar("MLX_CHAT_MODEL")).toBe(mlx.chatModel);
    expect(shellVar("MLX_EMBED_MODEL")).toBe(mlx.embeddingModel);
  });

  it("uses the same ports", () => {
    expect(ollama.chatBaseUrl).toBe(`http://localhost:${shellVar("OLLAMA_PORT")}`);
    expect(mlx.chatBaseUrl).toBe(`http://localhost:${shellVar("MLX_CHAT_PORT")}`);
    expect(mlx.embedBaseUrl).toBe(`http://localhost:${shellVar("MLX_EMBED_PORT")}`);
  });

  it("builds qwen3.8-pharma from the pulled base model with a 16k context", () => {
    expect(modelfile).toContain(`FROM ${shellVar("OLLAMA_BASE_MODEL")}`);
    expect(modelfile).toContain("PARAMETER num_ctx 16384");
  });

  it("warms up with the same thinking switch the client sends", () => {
    expect(script).toContain(`'"reasoning_effort":"none"'`);
    expect(script).toContain(`'"chat_template_kwargs":{"enable_thinking":false}'`);
    expect(JSON.stringify(ollama.chatExtraBody)).toBe('{"reasoning_effort":"none"}');
    expect(JSON.stringify(mlx.chatExtraBody)).toBe('{"chat_template_kwargs":{"enable_thinking":false}}');
  });
});

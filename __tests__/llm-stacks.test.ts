import { describe, expect, it } from "@jest/globals";
import { buildStacks, getActiveStack } from "../src/config/llm-stacks.js";

describe("getActiveStack", () => {
  it("defaults to the ollama stack", () => {
    expect(getActiveStack({}).name).toBe("ollama");
  });

  it("selects the mlx stack", () => {
    const stack = getActiveStack({ LLM_PROVIDER: "mlx" });
    expect(stack.name).toBe("mlx");
    expect(stack.chatModel).toBe("mlx-community/Qwen3.8-27B-4bit");
    expect(stack.embeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  it("throws on an unknown provider", () => {
    expect(() => getActiveStack({ LLM_PROVIDER: "lmstudio" })).toThrow('Invalid LLM_PROVIDER "lmstudio"');
  });
});

describe("buildStacks", () => {
  it("honours URL overrides", () => {
    const stacks = buildStacks({ OLLAMA_URL: "http://o:1", MLX_CHAT_URL: "http://m:2", MLX_EMBED_URL: "http://e:3" });
    expect(stacks.ollama.chatBaseUrl).toBe("http://o:1");
    expect(stacks.ollama.embedBaseUrl).toBe("http://o:1");
    expect(stacks.mlx.chatBaseUrl).toBe("http://m:2");
    expect(stacks.mlx.embedBaseUrl).toBe("http://e:3");
  });

  it("uses the same model family on both stacks and separate indexes", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.chatModel).toBe("qwen3.8-pharma");
    expect(ollama.embeddingModel).toBe("qwen3-embedding:0.6b-q8_0");
    expect(ollama.embeddingDim).toBe(1024);
    expect(mlx.embeddingDim).toBe(1024);
    expect(ollama.chromaCollection).toBe("knowledge_base_ollama");
    expect(mlx.chromaCollection).toBe("knowledge_base_mlx");
    expect(ollama.indexFile).toBe(".index.ollama.json");
    expect(mlx.indexFile).toBe(".index.mlx.json");
  });

  it("disables thinking on both stacks", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.chatExtraBody).toEqual({ reasoning_effort: "none" });
    expect(mlx.chatExtraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

import { describe, expect, it } from "@jest/globals";
import { buildStacks, getActiveStack, isStackName, STACK_NAMES } from "../src/config/llm-stacks.js";

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

  it("keeps each stack's own index identity where nothing is shared", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.indexStack).toBe("ollama");
    expect(ollama.indexEmbeddingModel).toBe(ollama.embeddingModel);
    expect(mlx.indexStack).toBe("mlx");
    expect(mlx.indexEmbeddingModel).toBe(mlx.embeddingModel);
  });

  it("disables thinking on both stacks", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.chatExtraBody).toEqual({ reasoning_effort: "none" });
    expect(mlx.chatExtraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

describe("omlx stack", () => {
  it("serves chat and embeddings from one server and shares the MLX index", () => {
    const { mlx, omlx } = buildStacks({});

    expect(omlx.name).toBe("omlx");
    expect(omlx.chatBaseUrl).toBe("http://localhost:8090");
    expect(omlx.embedBaseUrl).toBe(omlx.chatBaseUrl);
    expect(omlx.chatModel).toBe("mlx-community--Qwen3.8-27B-4bit");
    expect(omlx.embeddingModel).toBe("mlx-community--Qwen3-Embedding-0.6B-8bit");
    expect(omlx.embeddingDim).toBe(mlx.embeddingDim);
    expect(omlx.chromaCollection).toBe(mlx.chromaCollection);
    expect(omlx.indexFile).toBe(mlx.indexFile);
  });

  // F1: sharing the collection and the index file is not enough — the stack metadata stamped into
  // them has to match too, or the index guard invalidates the shared index on every mlx↔omlx switch.
  it("reads and writes the index under the MLX stack's identity, not its own", () => {
    const { mlx, omlx } = buildStacks({});
    expect(omlx.indexStack).toBe(mlx.indexStack);
    expect(omlx.indexEmbeddingModel).toBe(mlx.indexEmbeddingModel);
    expect(omlx.indexStack).toBe("mlx");
    expect(omlx.indexEmbeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  it("takes its URL from the environment", () => {
    expect(buildStacks({ OMLX_URL: "http://127.0.0.1:9100" }).omlx.chatBaseUrl).toBe("http://127.0.0.1:9100");
  });

  it("is selectable through LLM_PROVIDER", () => {
    expect(getActiveStack({ LLM_PROVIDER: "omlx" }).name).toBe("omlx");
  });

  it("rejects an unknown stack name and names all three", () => {
    expect(() => getActiveStack({ LLM_PROVIDER: "vllm" })).toThrow(/ollama.*mlx.*omlx/);
  });
});

describe("STACK_NAMES", () => {
  it("matches the keys of the stack map, so the list cannot drift from it", () => {
    expect([...STACK_NAMES].sort()).toEqual(Object.keys(buildStacks({})).sort());
  });
});

describe("isStackName", () => {
  it("accepts each known stack name", () => {
    for (const name of STACK_NAMES) expect(isStackName(name)).toBe(true);
  });

  it("rejects a non-string", () => {
    expect(isStackName(42)).toBe(false);
    expect(isStackName(undefined)).toBe(false);
    expect(isStackName(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isStackName(["omlx"])).toBe(false);
  });

  it("rejects an unknown name", () => {
    expect(isStackName("vllm")).toBe(false);
  });
});

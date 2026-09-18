// Stack definitions for the Ollama / MLX switch. Exactly one stack is active per process.

export type StackName = "ollama" | "mlx" | "omlx";

export interface StackConfig {
  name: StackName;
  chatBaseUrl: string;
  embedBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDim: number;
  chromaCollection: string;
  indexFile: string;
  // Extra request fields that keep both stacks comparable (thinking disabled)
  chatExtraBody: Record<string, unknown>;
}

const EMBEDDING_DIM = 1024;

export function buildStacks(env: NodeJS.ProcessEnv = process.env): Record<StackName, StackConfig> {
  const ollamaUrl = env.OLLAMA_URL ?? "http://localhost:11434";

  return {
    ollama: {
      name: "ollama",
      chatBaseUrl: ollamaUrl,
      embedBaseUrl: ollamaUrl,
      chatModel: "qwen3.8-pharma",
      embeddingModel: "qwen3-embedding:0.6b-q8_0",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_ollama",
      indexFile: ".index.ollama.json",
      chatExtraBody: { reasoning_effort: "none" },
    },
    mlx: {
      name: "mlx",
      chatBaseUrl: env.MLX_CHAT_URL ?? "http://localhost:8080",
      embedBaseUrl: env.MLX_EMBED_URL ?? "http://localhost:8081",
      chatModel: "mlx-community/Qwen3.8-27B-4bit",
      embeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      chatExtraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
    // oMLX serves chat and embeddings from one process; its embeddings are identical to the MLX
    // server's (cosine 1.000000, see the verification doc), so it shares the MLX index
    omlx: {
      name: "omlx",
      chatBaseUrl: env.OMLX_URL ?? "http://localhost:8090",
      embedBaseUrl: env.OMLX_URL ?? "http://localhost:8090",
      chatModel: "mlx-community--Qwen3.8-27B-4bit",
      embeddingModel: "mlx-community--Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      chatExtraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
  };
}

export function getActiveStack(env: NodeJS.ProcessEnv = process.env): StackConfig {
  const name = env.LLM_PROVIDER ?? "ollama";
  if (name !== "ollama" && name !== "mlx" && name !== "omlx") {
    throw new Error(`Invalid LLM_PROVIDER "${name}" (expected "ollama", "mlx" or "omlx")`);
  }
  return buildStacks(env)[name];
}

// Service de communication avec l'API Ollama

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
}

interface OllamaStreamChunk {
  model: string;
  message: OllamaMessage;
  done: boolean;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_MODEL = "gemma2:9b";
const DEFAULT_OPTIONS = {
  num_ctx: 4096,
  temperature: 0.3,
};

export async function chatWithOllama(
  messages: OllamaMessage[],
  model: string = DEFAULT_MODEL,
  optionsOverride?: Record<string, unknown>
): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      keep_alive: "30m",
      options: { ...DEFAULT_OPTIONS, ...optionsOverride },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OllamaResponse;
  return data.message.content;
}

export async function* streamChatWithOllama(
  messages: OllamaMessage[],
  model: string = DEFAULT_MODEL
): AsyncGenerator<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: "30m",
      options: DEFAULT_OPTIONS,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Pas de body dans la réponse");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        const chunk = JSON.parse(line) as OllamaStreamChunk;
        yield chunk.message.content;
      }
    }
  }
}

export async function listModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }
  const data = (await response.json()) as { models: Array<{ name: string }> };
  return data.models.map((m) => m.name);
}

export async function getEmbedding(text: string, model: string = DEFAULT_MODEL): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: text,
      keep_alive: "30m",
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embeddings error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OllamaEmbeddingResponse;
  return data.embedding;
}

export type { OllamaMessage };

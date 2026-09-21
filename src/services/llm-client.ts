// OpenAI-compatible client shared by the Ollama and MLX stacks.
// Both stacks go through this exact code path, so timings are measured the same way.

import { getActiveStack } from "../config/llm-stacks.js";
import type { StackConfig } from "../config/llm-stacks.js";
import { thinkingBody, type ThinkingLevel } from "./thinking.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// No model option: every call uses the stack's configured chat model
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  // Omitted means off: benchmarks, MCP and the Telegram path must not start
  // thinking just because a UI switch exists.
  thinking?: ThinkingLevel;
  // Called with each reasoning fragment. Kept off the yielded stream so the
  // answer a caller concatenates never contains thinking.
  onReasoning?: (text: string) => void;
}

export interface TokenStats {
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number;
  ttftMs: number;
  tokenCountSource: "usage" | "chunks";
}

export interface StatsCollector {
  result?: TokenStats;
}

export type EmbedKind = "query" | "document";

export interface LlmClient {
  readonly stack: StackConfig;
  streamChat(messages: ChatMessage[], options?: ChatOptions, stats?: StatsCollector): AsyncGenerator<string>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  embed(text: string, kind: EmbedKind): Promise<number[]>;
  embedMany(texts: string[], kind: EmbedKind): Promise<number[][]>;
  listModels(): Promise<string[]>;
  isReachable(): Promise<boolean>;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatCompletionChunk {
  // mlx_lm returns model thinking as a sibling of `content`, never as inline
  // <think> tags. Verified against mlx_lm 0.31.3 on 2026-09-21.
  choices?: Array<{ delta?: { content?: string | null; reasoning?: string | null } }>;
  usage?: Usage | null;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

interface ModelList {
  data?: Array<{ id: string }>;
}

export interface TimingInput {
  start: number;
  firstTokenAt: number | null;
  lastTokenAt: number;
  contentChunks: number;
  usage: Usage | null;
}

const DEFAULT_TEMPERATURE = 0.3;
const PROBE_TIMEOUT_MS = 3000;
// Stacks have different server defaults (mlx_lm.server stops at 512), so the client always sends an explicit limit.
const DEFAULT_MAX_TOKENS = 4096;

// Qwen3-Embedding expects an instruction on queries only; documents are embedded as-is
export const QUERY_INSTRUCTION =
  "Given a question about the pharmaceutical industry or its cybersecurity, retrieve passages that answer the question";

export class StackUnavailableError extends Error {
  constructor(stack: StackConfig, url: string, cause: unknown) {
    super(
      `${stack.name.toUpperCase()} stack not reachable at ${url} — run scripts/switch-stack.sh ${stack.name}`,
      { cause }
    );
    this.name = "StackUnavailableError";
  }
}

export function formatEmbeddingInput(text: string, kind: EmbedKind): string {
  return kind === "query" ? `Instruct: ${QUERY_INSTRUCTION}\nQuery:${text}` : text;
}

// Split a server-sent-events buffer into complete "data:" payloads plus the unfinished remainder
export function parseSseLines(buffer: string): { events: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return { events, rest };
}

export function computeTokenStats(input: TimingInput): TokenStats {
  const completionTokens = input.usage?.completion_tokens ?? input.contentChunks;
  const promptTokens = input.usage?.prompt_tokens ?? 0;
  const ttftMs = input.firstTokenAt === null ? 0 : input.firstTokenAt - input.start;
  const decodeMs = input.firstTokenAt === null ? 0 : input.lastTokenAt - input.firstTokenAt;
  // The first token comes out of prefill, so decode speed covers the tokens after it
  const tokensPerSecond = decodeMs > 0 && completionTokens > 1 ? ((completionTokens - 1) * 1000) / decodeMs : 0;

  return {
    promptTokens,
    completionTokens,
    tokensPerSecond,
    ttftMs,
    tokenCountSource: input.usage?.completion_tokens != null ? "usage" : "chunks",
  };
}

export function createLlmClient(stack: StackConfig, now: () => number = () => performance.now()): LlmClient {
  async function post(url: string, body: unknown): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new StackUnavailableError(stack, url, err);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${stack.name} ${new URL(url).pathname} failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return resp;
  }

  function chatBody(messages: ChatMessage[], options: ChatOptions, stream: boolean): Record<string, unknown> {
    return {
      model: stack.chatModel,
      messages,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...thinkingBody(stack, options.thinking ?? "off"),
    };
  }

  async function* streamChat(
    messages: ChatMessage[],
    options: ChatOptions = {},
    stats?: StatsCollector
  ): AsyncGenerator<string> {
    const start = now();
    const resp = await post(`${stack.chatBaseUrl}/v1/chat/completions`, chatBody(messages, options, true));
    const reader = resp.body?.getReader();
    if (!reader) throw new Error(`${stack.name}: empty response body`);

    const decoder = new TextDecoder();
    let buffer = "";
    let firstTokenAt: number | null = null;
    let lastTokenAt = start;
    let contentChunks = 0;
    let usage: Usage | null = null;
    let finished = false;

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseLines(buffer);
        buffer = parsed.rest;

        for (const data of parsed.events) {
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          if (chunk.usage) usage = chunk.usage;
          const reasoning = chunk.choices?.[0]?.delta?.reasoning;
          if (reasoning) options.onReasoning?.(reasoning);

          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            // Timestamp on arrival, before the consumer processes the token
            const arrivedAt = now();
            if (firstTokenAt === null) firstTokenAt = arrivedAt;
            lastTokenAt = arrivedAt;
            contentChunks++;
            yield content;
          }
        }
      }
    } finally {
      // Release the reader on normal completion, a parse/network error, or the
      // consumer breaking out of the loop early — otherwise the HTTP stream leaks.
      await reader.cancel().catch(() => {});
    }

    if (stats) {
      stats.result = computeTokenStats({ start, firstTokenAt, lastTokenAt, contentChunks, usage });
    }
  }

  async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const resp = await post(`${stack.chatBaseUrl}/v1/chat/completions`, chatBody(messages, options, false));
    const data = (await resp.json()) as ChatCompletion;
    return data.choices?.[0]?.message?.content ?? "";
  }

  async function embedMany(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return [];
    const resp = await post(`${stack.embedBaseUrl}/v1/embeddings`, {
      model: stack.embeddingModel,
      input: texts.map((text) => formatEmbeddingInput(text, kind)),
    });
    const data = (await resp.json()) as EmbeddingResponse;
    const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) {
      throw new Error(`${stack.name}: expected ${texts.length} embeddings, got ${rows.length}`);
    }
    return rows.map((row) => row.embedding);
  }

  async function embed(text: string, kind: EmbedKind): Promise<number[]> {
    const [vector] = await embedMany([text], kind);
    return vector;
  }

  async function listModels(): Promise<string[]> {
    const url = `${stack.chatBaseUrl}/v1/models`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (err) {
      throw new StackUnavailableError(stack, url, err);
    }
    if (!resp.ok) throw new Error(`${stack.name} /v1/models failed (${resp.status})`);
    const data = (await resp.json()) as ModelList;
    return (data.data ?? []).map((model) => model.id);
  }

  async function isReachable(): Promise<boolean> {
    const urls = [...new Set([`${stack.chatBaseUrl}/v1/models`, `${stack.embedBaseUrl}/v1/models`])];
    const results = await Promise.all(
      urls.map((url) =>
        fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
          .then((resp) => resp.ok)
          .catch(() => false)
      )
    );
    return results.every(Boolean);
  }

  return { stack, streamChat, chat, embed, embedMany, listModels, isReachable };
}

let activeClient: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  activeClient ??= createLlmClient(getActiveStack());
  return activeClient;
}

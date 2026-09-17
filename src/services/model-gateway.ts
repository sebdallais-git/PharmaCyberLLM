// OpenAI-compatible gateway: forwards agent chat completions to the active LLM stack

import type { Response as ExpressResponse } from "express";
import type { StackConfig } from "../config/llm-stacks.js";
import { StackUnavailableError } from "./llm-client.js";

export const GATEWAY_MAX_TOKENS = 4096;

// Fields agents may set; everything else (model, n, …) is dropped so the stack stays in control
const PASSTHROUGH_FIELDS = ["tools", "tool_choice", "stream", "stream_options", "temperature"] as const;

export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = type;
  }
}

export interface OpenAiErrorBody {
  error: { message: string; type: string };
}

export interface GatewayDeps {
  stack: StackConfig;
  fetchImpl: typeof fetch;
  isBenchmarkActive: () => boolean;
  trackJob: <T>(name: string, job: () => Promise<T>) => Promise<T>;
}

export function openAiError(message: string, type: string): OpenAiErrorBody {
  return { error: { message, type } };
}

export function buildUpstreamBody(body: unknown, stack: StackConfig): Record<string, unknown> {
  const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new GatewayError(400, "invalid_request_error", "messages must be a non-empty array");
  }

  const upstream: Record<string, unknown> = { messages: input.messages };
  for (const field of PASSTHROUGH_FIELDS) {
    if (input[field] !== undefined) upstream[field] = input[field];
  }

  const requested =
    typeof input.max_tokens === "number" && input.max_tokens > 0 ? Math.floor(input.max_tokens) : GATEWAY_MAX_TOKENS;
  upstream.max_tokens = Math.min(requested, GATEWAY_MAX_TOKENS);
  upstream.model = stack.chatModel;

  return { ...upstream, ...stack.chatExtraBody };
}

export function modelList(stack: StackConfig): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} {
  return { object: "list", data: [{ id: stack.chatModel, object: "model", created: 0, owned_by: "pharmallm" }] };
}

export async function forwardChatCompletion(body: unknown, res: ExpressResponse, deps: GatewayDeps): Promise<void> {
  if (deps.isBenchmarkActive()) {
    res.status(503).json(openAiError("Benchmark in progress — try again after it finishes", "service_unavailable"));
    return;
  }

  let upstreamBody: Record<string, unknown>;
  try {
    upstreamBody = buildUpstreamBody(body, deps.stack);
  } catch (err) {
    if (err instanceof GatewayError) {
      res.status(err.status).json(openAiError(err.message, err.type));
      return;
    }
    throw err;
  }

  const url = `${deps.stack.chatBaseUrl}/v1/chat/completions`;
  const controller = new AbortController();
  // Stop generating upstream if the agent disconnects mid-response
  res.on("close", () => controller.abort());

  await deps.trackJob("agent-completion", async () => {
    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(503).json(openAiError(new StackUnavailableError(deps.stack, url, err).message, "service_unavailable"));
      }
      return;
    }

    // Pass status, content type and body through byte for byte (JSON or server-sent events)
    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    const reader = upstream.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // The agent disconnected or the stack aborted; nothing more to send
    } finally {
      await reader.cancel().catch(() => {});
      res.end();
    }
  });
}

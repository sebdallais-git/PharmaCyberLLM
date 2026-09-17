// REST client for PharmaLLM used by the MCP tools

import { Agent, fetch as undiciFetch } from "undici";

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal;
}

// The parts of a fetch Response the client reads; both undici's and the global fetch satisfy it
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null;
  text(): Promise<string>;
}

export interface FetchImpl {
  (url: string, init: FetchInit): Promise<FetchResponse>;
}

// Node's built-in fetch gives up after 300 s without headers or body data; long tools (news agent,
// gap resolution) need more, so undici's limits are off and only our own deadline applies
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const defaultFetch: FetchImpl = (url, init) =>
  undiciFetch(url, { ...init, dispatcher: noTimeoutAgent });

export class PharmaLLMError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "PharmaLLMError";
    this.status = status;
  }
}

export interface ChatAnswer {
  answer: string;
  sources: string[];
  stack: string | null;
  response_id: string | null;
  timings: Record<string, number> | null;
}

export interface PharmaLLMClient {
  readonly baseUrl: string;
  get(path: string, timeoutMs?: number): Promise<unknown>;
  post(path: string, body: unknown, timeoutMs?: number): Promise<unknown>;
  ask(question: string, webSearch: boolean, timeoutMs: number): Promise<ChatAnswer>;
}

interface ChatEvent {
  token?: string;
  sources?: unknown;
  error?: string;
  done?: boolean;
  stack?: string;
  response_id?: string;
  timings?: Record<string, number>;
}

const UNDICI_TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function hasUndiciTimeoutCause(err: TypeError): boolean {
  const cause: unknown = err.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return typeof cause.code === "string" && UNDICI_TIMEOUT_CODES.has(cause.code);
}

function isTimeout(err: unknown): boolean {
  if (err instanceof TypeError) return hasUndiciTimeoutCause(err);
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

// A response whose deadline keeps running until the caller has read the body
interface PendingResponse {
  response: FetchResponse;
  timedOut(): boolean;
  finish(): void;
}

function timeoutError(timeoutMs: number): PharmaLLMError {
  return new PharmaLLMError(`PharmaLLM did not answer within ${timeoutMs / 1000} s`, null);
}

function errorDetail(payload: unknown, text: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return text.slice(0, 300);
}

export function createPharmaLLMClient(
  baseUrl: string,
  token: string | null,
  fetchImpl: FetchImpl = defaultFetch
): PharmaLLMClient {
  async function send(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<PendingResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      return { response, timedOut: () => timedOut, finish: () => clearTimeout(timeoutHandle) };
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (timedOut || isTimeout(err)) throw timeoutError(timeoutMs);
      throw new PharmaLLMError(`PharmaLLM not reachable at ${baseUrl}`, null);
    }
  }

  async function readJson(pending: PendingResponse, path: string, timeoutMs: number): Promise<unknown> {
    const resp = pending.response;
    let text: string;
    try {
      text = await resp.text();
    } catch (err) {
      if (pending.timedOut() || isTimeout(err)) throw timeoutError(timeoutMs);
      throw new PharmaLLMError(`PharmaLLM ${path} response could not be read`, resp.status);
    }

    let payload: unknown = text;
    try {
      payload = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // Not JSON: keep the raw text
    }

    if (resp.status === 401) {
      throw new PharmaLLMError("PharmaLLM rejected the API token — check PHARMALLM_API_TOKEN", 401);
    }
    if (!resp.ok) {
      throw new PharmaLLMError(`PharmaLLM ${path} failed (${resp.status}): ${errorDetail(payload, text)}`, resp.status);
    }
    return payload;
  }

  async function request(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const pending = await send(method, path, body, timeoutMs);
    try {
      return await readJson(pending, path, timeoutMs);
    } finally {
      pending.finish();
    }
  }

  async function ask(question: string, webSearch: boolean, timeoutMs: number): Promise<ChatAnswer> {
    const path = "/api/chat";
    const pending = await send("POST", path, { message: question, webSearch }, timeoutMs);
    try {
      return await readChatStream(pending, path, timeoutMs);
    } finally {
      pending.finish();
    }
  }

  async function readChatStream(pending: PendingResponse, path: string, timeoutMs: number): Promise<ChatAnswer> {
    const resp = pending.response;
    if (!resp.ok) {
      await readJson(pending, path, timeoutMs);
    }
    const reader = resp.body?.getReader();
    if (!reader) throw new PharmaLLMError(`PharmaLLM ${path} returned no stream`, resp.status);

    const decoder = new TextDecoder();
    const sources = new Set<string>();
    let answer = "";
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5).trim()) as ChatEvent;
          if (event.error) throw new PharmaLLMError(event.error, null);
          if (Array.isArray(event.sources)) {
            for (const source of event.sources) {
              if (typeof source === "string") sources.add(source);
            }
          }
          if (event.token) answer += event.token;
          if (event.done) {
            return {
              answer,
              sources: [...sources],
              stack: event.stack ?? null,
              response_id: event.response_id ?? null,
              timings: event.timings ?? null,
            };
          }
        }
      }
    } catch (err) {
      if (err instanceof PharmaLLMError) throw err;
      if (pending.timedOut() || isTimeout(err)) throw timeoutError(timeoutMs);
      throw new PharmaLLMError(`PharmaLLM chat stream failed: ${err instanceof Error ? err.message : String(err)}`, null);
    } finally {
      await reader.cancel().catch(() => {});
    }

    throw new PharmaLLMError("PharmaLLM chat stream ended without an answer", null);
  }

  return {
    baseUrl,
    get: (path, timeoutMs = DEFAULT_TIMEOUT_MS) => request("GET", path, undefined, timeoutMs),
    post: (path, body, timeoutMs = DEFAULT_TIMEOUT_MS) => request("POST", path, body, timeoutMs),
    ask,
  };
}

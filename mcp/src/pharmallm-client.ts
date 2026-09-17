// REST client for PharmaLLM used by the MCP tools

export const DEFAULT_TIMEOUT_MS = 30_000;

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

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
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
  fetchImpl: typeof fetch = fetch
): PharmaLLMClient {
  async function send(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<Response> {
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
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (timedOut || isTimeout(err)) throw timeoutError(timeoutMs);
      throw new PharmaLLMError(`PharmaLLM not reachable at ${baseUrl}`, null);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function readJson(resp: Response, path: string, timeoutMs: number): Promise<unknown> {
    let text: string;
    try {
      text = await resp.text();
    } catch (err) {
      if (isTimeout(err)) throw timeoutError(timeoutMs);
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

  async function ask(question: string, webSearch: boolean, timeoutMs: number): Promise<ChatAnswer> {
    const path = "/api/chat";
    const resp = await send("POST", path, { message: question, webSearch }, timeoutMs);
    if (!resp.ok) {
      await readJson(resp, path, timeoutMs);
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
      if (isTimeout(err)) throw timeoutError(timeoutMs);
      throw new PharmaLLMError(`PharmaLLM chat stream failed: ${err instanceof Error ? err.message : String(err)}`, null);
    } finally {
      await reader.cancel().catch(() => {});
    }

    throw new PharmaLLMError("PharmaLLM chat stream ended without an answer", null);
  }

  return {
    baseUrl,
    async get(path, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return readJson(await send("GET", path, undefined, timeoutMs), path, timeoutMs);
    },
    async post(path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return readJson(await send("POST", path, body, timeoutMs), path, timeoutMs);
    },
    ask,
  };
}

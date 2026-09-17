# PharmaLLM MCP Server and Agent Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AI agents (first Hermes Agent) use PharmaLLM through a standalone MCP service and an OpenAI-compatible model gateway, protected by tokens and usable across two Macs on a LAN.

**Architecture:** A new `mcp/` package (`pharmallm-mcp`) serves MCP over stateless Streamable HTTP and maps 16 tools to PharmaLLM REST calls. PharmaLLM gains an auth middleware (`PHARMALLM_API_TOKEN`, loopback-only when unset), a `/v1` gateway that forwards OpenAI chat completions to the active stack, and an asynchronous reindex job API.

**Tech Stack:** Node 22, TypeScript strict ESM, Express 4, `@modelcontextprotocol/sdk` 1.30.0, zod 4, Jest 30 + ts-jest (ESM), Bash.

**Spec:** `docs/superpowers/specs/2026-09-17-pharmallm-mcp-server-design.md`

## Planning Notes

1. **SDK API verified with a running prototype** (data/run/sdk-probe, 2026-09-17): `new McpServer({ name, version })`, `server.registerTool(name, { description, inputSchema: <zod raw shape> }, async (args) => CallToolResult)`, `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` + `await server.connect(transport)` + `await transport.handleRequest(req, res, req.body)` on Express; client `new Client({ name, version })`, `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`, `client.listTools()`, `client.callTool({ name, arguments })`. Invalid tool input and handler errors come back as `{ isError: true, content: [...] }`.
2. **Tool calling verified on Ollama** (`qwen3.8-pharma` returned a `get_weather` tool call through `/v1/chat/completions`). **MLX** is expected to work: Qwen3.8's chat template contains `<tool_call>\n<function=`, which `mlx-lm` 0.31.3 maps to its `qwen3_coder` parser — Task 0 confirms it live.
3. **Browser UI routes** (stay open): found by scanning `public/app.js` and `dashboard/index.html`.
4. **n8n is not running** on the Mac mini right now (`:5678` closed), so the `$env` header expression can't be tested live; Task 8 documents the required n8n setting.
5. **Root Jest would pick up `mcp/__tests__`** (`testMatch: **/__tests__/**`); Task 1 excludes `mcp/` and `data/` from the root run. The MCP package has its own Jest config.
6. `benchmark-stack.ts` calls protected routes (`/api/bench/*`), so it must send the token when one is configured (Task 5).

## Global Constraints

- TypeScript strict mode; ES modules with `.js` import specifiers; no `any` (use `unknown` + type guards); prefer `interface` over `type` aliases except for unions.
- camelCase functions, PascalCase classes, kebab-case file names; code comments in English, matching surrounding density.
- Run `npm run typecheck` (and `npm --prefix mcp run typecheck` for the MCP package) after every code change; every new module gets Jest tests.
- **No test may reach real ChromaDB, model servers, `knowledge/.index.*.json`, or the running app.** Use fake HTTP servers and injected dependencies. Never demonstrate a failing test by reverting an implementation file.
- Never modify `.env` files or `/legacy`.
- Commit prefixes `feat:`, `fix:`, `refactor:`, `test:`, `docs:`; every commit message ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Stage explicit paths only (never `git add -A` / `git add .`).
- Work on branch `feature/pharmallm-mcp-gateway`.
- MCP service defaults: `MCP_PORT=3200`, `MCP_HOST=127.0.0.1`, `PHARMALLM_URL=http://localhost:3000`; `MCP_TOKEN` required when `MCP_HOST` is not loopback.
- PharmaLLM token: `PHARMALLM_API_TOKEN`; token file `data/run/api-token` (hex, mode 600); no token → protected routes accept loopback only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
- Browser allowlist (method + path): `POST /api/chat`, `GET /api/chat/models`, `POST /api/chat/transcribe`, `POST /api/knowledge/search`, `GET /api/knowledge/stats`, `POST /api/knowledge/upload`, `POST /api/knowledge/ingest-text`, `POST /api/agent/run`, `GET /api/agent/status`, `GET /api/dashboard/metrics`, `GET /api/dashboard/chromadb-misses`, `GET /api/graph/stats`, `GET /api/health`.
- Gateway: model always the active stack's `chatModel`; stack `chatExtraBody` merged; `max_tokens` default and cap 4096; 503 during benchmark mode or when the stack is down; wrapped in `trackJob("agent-completion", …)`.
- Timeouts in the MCP client: `ask_pharmallm` 5 min, `run_news_agent` 15 min, everything else 30 s.
- Do not expose stack switching, benchmark control, graph rebuild or transcription as tools.

## File Map

| File | Responsibility |
|------|----------------|
| `mcp/package.json`, `mcp/tsconfig.json`, `mcp/jest.config.js` | MCP package setup |
| `mcp/src/config.ts` | Env config, loopback helpers, token comparison |
| `mcp/src/pharmallm-client.ts` | REST client to PharmaLLM (auth header, timeouts, errors, chat SSE collection) |
| `mcp/src/tools/result.ts` | Tool result helpers and logged tool runner |
| `mcp/src/tools/knowledge.ts`, `graph.ts`, `gaps.ts`, `operations.ts`, `feedback.ts` | Tool groups |
| `mcp/src/mcp-server.ts` | Build `McpServer` with all tools |
| `mcp/src/http.ts` | Express app: `/mcp` auth + transport, `/healthz` |
| `mcp/src/server.ts` | Entry point |
| `mcp/__tests__/helpers/fake-pharmallm.ts`, `mcp/__tests__/helpers/harness.ts` | Fake PharmaLLM server; MCP client harness |
| `mcp/README.md` | Usage, config, Hermes snippet |
| `src/api/auth.ts` | Auth decision + Express middleware |
| `src/services/model-gateway.ts`, `src/api/v1.ts` | `/v1` gateway |
| `src/services/reindex-jobs.ts` | In-memory async reindex job store |
| `src/server.ts`, `src/api/knowledge.ts`, `src/services/reindex.ts` | Mount auth + `/v1`; async reindex routes; progress callback |
| `scripts/benchmark-stack.ts`, `scripts/switch-stack.sh`, `scripts/start-services.sh` | Send/export token; `token` command |
| `n8n/*.json`, `n8n/README.md`, `README.md`, `jest.config.js` | Token headers, docs, Jest exclusion |

---

### Task 0: Verification spike

No code. Confirms MLX tool calling live and loopback address formats before building on them.

**Files:**
- Create: `docs/superpowers/plans/2026-09-17-pharmallm-mcp-server-verification.md`

- [ ] **Step 1: Tell the user** that this step switches PharmaLLM to the MLX stack for a few minutes and back to Ollama (indexes are already complete, so no rebuild).

- [ ] **Step 2: Switch to MLX and test tool calling**

```bash
scripts/switch-stack.sh mlx
curl -s http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "mlx-community/Qwen3.8-27B-4bit",
  "chat_template_kwargs": {"enable_thinking": false}, "max_tokens": 120,
  "messages": [{"role": "user", "content": "What is the weather in Basel? Use the tool."}],
  "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); c=d["choices"][0]; print(c["finish_reason"], json.dumps(c["message"].get("tool_calls")))'
```

Expected: `tool_calls [{"...": ..., "function": {"name": "get_weather", "arguments": "{\"city\": \"Basel\"}"}}]` (argument formatting may differ). Repeat with `"stream": true` and check that the SSE stream contains a `tool_calls` delta:

```bash
curl -sN http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "mlx-community/Qwen3.8-27B-4bit", "stream": true,
  "chat_template_kwargs": {"enable_thinking": false}, "max_tokens": 120,
  "messages": [{"role": "user", "content": "What is the weather in Basel? Use the tool."}],
  "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]}' | grep -c tool_calls
```

Expected: a count ≥ 1.

- [ ] **Step 3: Switch back to Ollama**

```bash
scripts/switch-stack.sh ollama
```

Expected: `Indexes for ollama are ready`, `PharmaLLM is up on the ollama stack`.

- [ ] **Step 4: Check loopback address formats seen by Express**

```bash
cat > data/run/loopback-probe.mjs <<'EOF'
import http from "node:http";
const server = http.createServer((req, res) => { res.end(String(req.socket.remoteAddress)); });
server.listen(0, "::", async () => {
  const { port } = server.address();
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    const text = await (await fetch(`http://${host}:${port}/`)).text();
    console.log(host, "->", text);
  }
  server.close();
});
EOF
node data/run/loopback-probe.mjs; rm data/run/loopback-probe.mjs
```

Expected: remote addresses are among `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. If another format appears, record it; Task 1 and Task 5 loopback helpers must include it.

- [ ] **Step 5: Record and commit**

Write the verification doc with each step's command, output excerpt, and pass/fail. If MLX tool calling fails, stop and report to the user before Task 6 (the gateway still works for Ollama; MLX tool calling would need a follow-up).

```bash
git add docs/superpowers/plans/2026-09-17-pharmallm-mcp-server-verification.md
git commit -m "docs: record MCP gateway verification spike

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: MCP package scaffold and config

**Files:**
- Create: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/jest.config.js`, `mcp/src/config.ts`, `mcp/__tests__/config.test.ts`
- Modify: `jest.config.js` (root)

**Interfaces:**
- Produces (`mcp/src/config.ts`):
  - `interface McpConfig { port: number; host: string; mcpToken: string | null; pharmallmUrl: string; pharmallmToken: string | null }`
  - `loadConfig(env?: NodeJS.ProcessEnv): McpConfig` (throws on invalid port or missing `MCP_TOKEN` for non-loopback host)
  - `isLoopbackHost(host: string): boolean`
  - `isLoopbackAddress(address: string | undefined): boolean`
  - `tokensMatch(expected: string, provided: string): boolean` (constant time)
  - `bearerToken(authorization: string | undefined): string | null`

- [ ] **Step 1: Exclude `mcp/` and `data/` from the root Jest run**

In the root `jest.config.js`, add `testPathIgnorePatterns` below `testMatch`:

```js
  testMatch: ["**/__tests__/**/*.test.ts"],
  // The MCP service is a separate package with its own Jest setup; data/ holds scratch installs
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/mcp/", "<rootDir>/data/"],
```

Run: `npm run test 2>&1 | grep -a "Tests:" | sed 's/\x1b\[[0-9;]*m//g'`
Expected: `Tests:       101 passed, 101 total`.

- [ ] **Step 2: Create the package files**

Create `mcp/package.json`:

```json
{
  "name": "pharmallm-mcp",
  "version": "1.0.0",
  "description": "MCP service exposing PharmaLLM to AI agents",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "tsx src/server.ts",
    "dev": "tsx watch src/server.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-vm-modules --disable-warning=ExperimentalWarning node_modules/jest/bin/jest.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "express": "^4.21.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@jest/globals": "^30.0.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "jest": "^30.0.0",
    "ts-jest": "^29.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

Create `mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*", "__tests__/**/*"]
}
```

Create `mcp/jest.config.js`:

```js
// Jest runs TypeScript tests as native ES modules (package.json has "type": "module")
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    // Source files import siblings as "./x.js"; point Jest at the .ts file
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.json" }],
  },
};
```

Run: `npm --prefix mcp install`
Expected: installs without errors; `mcp/node_modules/@modelcontextprotocol/sdk/package.json` has version `1.30.0`. (`node_modules/` is already gitignored at any depth.)

- [ ] **Step 3: Write the failing config tests**

Create `mcp/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { bearerToken, isLoopbackAddress, isLoopbackHost, loadConfig, tokensMatch } from "../src/config.js";

describe("loadConfig", () => {
  it("uses local defaults", () => {
    expect(loadConfig({})).toEqual({
      port: 3200,
      host: "127.0.0.1",
      mcpToken: null,
      pharmallmUrl: "http://localhost:3000",
      pharmallmToken: null,
    });
  });

  it("reads overrides and trims the PharmaLLM URL", () => {
    const config = loadConfig({
      MCP_PORT: "4100",
      MCP_HOST: "0.0.0.0",
      MCP_TOKEN: " agent-secret ",
      PHARMALLM_URL: "http://model-mac.local:3000/",
      PHARMALLM_API_TOKEN: "app-secret",
    });
    expect(config).toEqual({
      port: 4100,
      host: "0.0.0.0",
      mcpToken: "agent-secret",
      pharmallmUrl: "http://model-mac.local:3000",
      pharmallmToken: "app-secret",
    });
  });

  it("refuses a non-loopback host without MCP_TOKEN", () => {
    expect(() => loadConfig({ MCP_HOST: "0.0.0.0" })).toThrow(
      "MCP_TOKEN is required when MCP_HOST (0.0.0.0) is not a loopback address"
    );
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ MCP_PORT: "nope" })).toThrow('Invalid MCP_PORT "nope"');
  });
});

describe("loopback helpers", () => {
  it("recognizes loopback hosts and addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("100.69.110.112")).toBe(false);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("192.168.50.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("token helpers", () => {
  it("extracts a bearer token", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("compares tokens of any length safely", () => {
    expect(tokensMatch("secret", "secret")).toBe(true);
    expect(tokensMatch("secret", "secreT")).toBe(false);
    expect(tokensMatch("secret", "much-longer-secret")).toBe(false);
  });
});
```

Run: `npm --prefix mcp test -- __tests__/config.test.ts`
Expected: FAIL with `Cannot find module '../src/config.js'`.

- [ ] **Step 4: Implement the config module**

Create `mcp/src/config.ts`:

```ts
// Environment configuration for the PharmaLLM MCP service

import { createHash, timingSafeEqual } from "node:crypto";

export interface McpConfig {
  port: number;
  host: string;
  mcpToken: string | null;
  pharmallmUrl: string;
  pharmallmToken: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Hash both sides first so timingSafeEqual always compares equal-length buffers
export function tokensMatch(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const port = Number(env.MCP_PORT ?? "3200");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_PORT "${env.MCP_PORT}"`);
  }

  const host = env.MCP_HOST ?? "127.0.0.1";
  const mcpToken = env.MCP_TOKEN?.trim() || null;
  if (!isLoopbackHost(host) && !mcpToken) {
    throw new Error(`MCP_TOKEN is required when MCP_HOST (${host}) is not a loopback address`);
  }

  return {
    port,
    host,
    mcpToken,
    pharmallmUrl: (env.PHARMALLM_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    pharmallmToken: env.PHARMALLM_API_TOKEN?.trim() || null,
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm --prefix mcp test -- __tests__/config.test.ts && npm --prefix mcp run typecheck`
Expected: PASS, 7 tests; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add jest.config.js mcp/package.json mcp/package-lock.json mcp/tsconfig.json mcp/jest.config.js mcp/src/config.ts mcp/__tests__/config.test.ts
git commit -m "feat: scaffold pharmallm-mcp package with config and token helpers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: PharmaLLM REST client

**Files:**
- Create: `mcp/src/pharmallm-client.ts`, `mcp/__tests__/helpers/fake-pharmallm.ts`, `mcp/__tests__/pharmallm-client.test.ts`

**Interfaces:**
- Produces (`mcp/src/pharmallm-client.ts`):
  - `const DEFAULT_TIMEOUT_MS = 30_000`
  - `class PharmaLLMError extends Error { readonly status: number | null }`
  - `interface ChatAnswer { answer: string; sources: string[]; stack: string | null; response_id: string | null; timings: Record<string, number> | null }`
  - `interface PharmaLLMClient { readonly baseUrl: string; get(path: string, timeoutMs?: number): Promise<unknown>; post(path: string, body: unknown, timeoutMs?: number): Promise<unknown>; ask(question: string, webSearch: boolean, timeoutMs: number): Promise<ChatAnswer> }`
  - `createPharmaLLMClient(baseUrl: string, token: string | null, fetchImpl?: typeof fetch): PharmaLLMClient`
- Produces (test helper `mcp/__tests__/helpers/fake-pharmallm.ts`):
  - `interface FakeRequest { method: string; path: string; headers: IncomingHttpHeaders; body: unknown }`
  - `interface FakeHandler { (req: FakeRequest, res: ServerResponse): void }`
  - `interface FakePharmaLLM { url: string; requests: FakeRequest[]; on(method: string, path: string, handler: FakeHandler): void; close(): Promise<void> }`
  - `startFakePharmaLLM(): Promise<FakePharmaLLM>`, `sendJson(res, status, payload)`, `sendSse(res, events: unknown[])`

- [ ] **Step 1: Create the fake PharmaLLM server helper**

Create `mcp/__tests__/helpers/fake-pharmallm.ts`:

```ts
// Minimal HTTP server that stands in for PharmaLLM's REST API in tests

import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeHandler {
  (req: FakeRequest, res: ServerResponse): void;
}

export interface FakePharmaLLM {
  url: string;
  requests: FakeRequest[];
  on(method: string, path: string, handler: FakeHandler): void;
  close(): Promise<void>;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function sendSse(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

export async function startFakePharmaLLM(): Promise<FakePharmaLLM> {
  const routes = new Map<string, FakeHandler>();
  const requests: FakeRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      const recorded: FakeRequest = {
        method: req.method ?? "",
        path,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      };
      requests.push(recorded);
      const handler = routes.get(`${recorded.method} ${path}`);
      if (handler) {
        handler(recorded, res);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // fetch keeps connections alive; drop them so close() doesn't wait
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 2: Write the failing client tests**

Create `mcp/__tests__/pharmallm-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createPharmaLLMClient, PharmaLLMError } from "../src/pharmallm-client.js";
import { sendJson, sendSse, startFakePharmaLLM } from "./helpers/fake-pharmallm.js";
import type { FakePharmaLLM } from "./helpers/fake-pharmallm.js";

let pharma: FakePharmaLLM;

beforeEach(async () => {
  pharma = await startFakePharmaLLM();
});

afterEach(async () => {
  await pharma.close();
});

describe("get and post", () => {
  it("sends the API token and parses JSON", async () => {
    pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy" }));
    const client = createPharmaLLMClient(pharma.url, "app-secret");

    await expect(client.get("/api/health")).resolves.toEqual({ status: "healthy" });
    expect(pharma.requests[0].headers.authorization).toBe("Bearer app-secret");
  });

  it("sends no Authorization header without a token and posts JSON", async () => {
    pharma.on("POST", "/api/knowledge/search", (_req, res) => sendJson(res, 200, { results: [] }));
    const client = createPharmaLLMClient(pharma.url, null);

    await client.post("/api/knowledge/search", { query: "Dell", topK: 5 });
    expect(pharma.requests[0].headers.authorization).toBeUndefined();
    expect(pharma.requests[0].body).toEqual({ query: "Dell", topK: 5 });
  });

  it("explains a rejected token", async () => {
    pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 401, { error: "Unauthorized" }));
    const client = createPharmaLLMClient(pharma.url, "wrong");

    await expect(client.get("/api/health")).rejects.toThrow(
      "PharmaLLM rejected the API token — check PHARMALLM_API_TOKEN"
    );
  });

  it("includes status and PharmaLLM's error message", async () => {
    pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 503, { error: "Search refused: index incomplete" })
    );
    const client = createPharmaLLMClient(pharma.url, null);

    const error = await client.post("/api/knowledge/search", { query: "x" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PharmaLLMError);
    expect((error as PharmaLLMError).status).toBe(503);
    expect((error as PharmaLLMError).message).toBe(
      "PharmaLLM /api/knowledge/search failed (503): Search refused: index incomplete"
    );
  });

  it("reports an unreachable PharmaLLM", async () => {
    const client = createPharmaLLMClient("http://127.0.0.1:9", null);
    await expect(client.get("/api/health")).rejects.toThrow("PharmaLLM not reachable at http://127.0.0.1:9");
  });

  it("times out a slow request", async () => {
    pharma.on("GET", "/api/health", () => {
      // never answers
    });
    const client = createPharmaLLMClient(pharma.url, null);
    await expect(client.get("/api/health", 50)).rejects.toThrow("PharmaLLM did not answer within 0.05 s");
  });
});

describe("ask", () => {
  it("collects the answer, sources and done fields from the chat stream", async () => {
    pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [
        { reasoning: "Searching knowledge base...", sources: [] },
        { reasoning: "Found 2 chunks", sources: ["vendor-dell-cyber-recovery.md", "pharma-basics.md"] },
        { reasoning: "Found 1 web result", sources: ["vendor-dell-cyber-recovery.md"] },
        { token: "Dell " },
        { token: "isolates backups." },
        { done: true, stack: "ollama", response_id: "r-1", timings: { totalMs: 1234 } },
      ])
    );
    const client = createPharmaLLMClient(pharma.url, null);

    await expect(client.ask("How does Dell protect backups?", false, 5000)).resolves.toEqual({
      answer: "Dell isolates backups.",
      sources: ["vendor-dell-cyber-recovery.md", "pharma-basics.md"],
      stack: "ollama",
      response_id: "r-1",
      timings: { totalMs: 1234 },
    });
    expect(pharma.requests[0].body).toEqual({ message: "How does Dell protect backups?", webSearch: false });
  });

  it("turns a stream error event into a PharmaLLMError", async () => {
    pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [{ error: "OLLAMA stack not reachable at http://localhost:11434/v1/chat/completions" }])
    );
    const client = createPharmaLLMClient(pharma.url, null);

    await expect(client.ask("hi", false, 5000)).rejects.toThrow("OLLAMA stack not reachable");
  });

  it("fails when the stream ends without an answer", async () => {
    pharma.on("POST", "/api/chat", (_req, res) => sendSse(res, [{ token: "partial" }]));
    const client = createPharmaLLMClient(pharma.url, null);

    await expect(client.ask("hi", false, 5000)).rejects.toThrow("PharmaLLM chat stream ended without an answer");
  });
});
```

Run: `npm --prefix mcp test -- __tests__/pharmallm-client.test.ts`
Expected: FAIL with `Cannot find module '../src/pharmallm-client.js'`.

- [ ] **Step 3: Implement the client**

Create `mcp/src/pharmallm-client.ts`:

```ts
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
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) throw timeoutError(timeoutMs);
      throw new PharmaLLMError(`PharmaLLM not reachable at ${baseUrl}`, null);
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
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm --prefix mcp test -- __tests__/pharmallm-client.test.ts && npm --prefix mcp run typecheck`
Expected: PASS, 9 tests, no open-handle warning; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/pharmallm-client.ts mcp/__tests__/helpers/fake-pharmallm.ts mcp/__tests__/pharmallm-client.test.ts
git commit -m "feat: add PharmaLLM REST client for the MCP service

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: MCP HTTP app, auth and knowledge tools

**Files:**
- Create: `mcp/src/tools/result.ts`, `mcp/src/tools/knowledge.ts`, `mcp/src/mcp-server.ts`, `mcp/src/http.ts`, `mcp/__tests__/helpers/harness.ts`, `mcp/__tests__/http.test.ts`, `mcp/__tests__/knowledge-tools.test.ts`

**Interfaces:**
- Consumes: `McpConfig`, `bearerToken`, `tokensMatch`, `isLoopbackAddress` (Task 1); `PharmaLLMClient`, `createPharmaLLMClient`, `DEFAULT_TIMEOUT_MS` (Task 2); `startFakePharmaLLM`, `sendJson`, `sendSse` (Task 2 helper).
- Produces:
  - `mcp/src/tools/result.ts`: `interface ToolLogger { (line: string): void }`, `defaultToolLogger`, `silentToolLogger`, `textResult(value: unknown): CallToolResult`, `errorResult(message: string): CallToolResult`, `runTool(name: string, log: ToolLogger, fn: () => Promise<unknown>): Promise<CallToolResult>`
  - `mcp/src/tools/knowledge.ts`: `const ASK_TIMEOUT_MS = 300_000`, `registerKnowledgeTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void`
  - `mcp/src/mcp-server.ts`: `const SERVER_INFO = { name: "pharmallm", version: "1.0.0" }`, `buildMcpServer(client: PharmaLLMClient, log: ToolLogger): McpServer`
  - `mcp/src/http.ts`: `authorizeMcpRequest(token: string | null, authorization: string | undefined, remoteAddress: string | undefined): McpAuthResult` with `interface McpAuthResult { ok: boolean; message: string }`; `createHttpApp(config: McpConfig, client: PharmaLLMClient, log: ToolLogger): Express`
  - Test harness `mcp/__tests__/helpers/harness.ts`: `interface HarnessOptions { mcpToken?: string | null; pharmallmToken?: string | null }`, `interface Harness { pharma: FakePharmaLLM; client: Client; mcpUrl: string; close(): Promise<void> }`, `startHarness(options?: HarnessOptions): Promise<Harness>`, `toolText(result: unknown): string`, `isToolError(result: unknown): boolean`

- [ ] **Step 1: Write the test harness**

Create `mcp/__tests__/helpers/harness.ts`:

```ts
// Starts a fake PharmaLLM, the MCP HTTP app, and a connected MCP client

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http.js";
import { createPharmaLLMClient } from "../../src/pharmallm-client.js";
import { silentToolLogger } from "../../src/tools/result.js";
import { startFakePharmaLLM } from "./fake-pharmallm.js";
import type { FakePharmaLLM } from "./fake-pharmallm.js";

export interface HarnessOptions {
  mcpToken?: string | null;
  pharmallmToken?: string | null;
}

export interface Harness {
  pharma: FakePharmaLLM;
  client: Client;
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const pharma = await startFakePharmaLLM();
  const config: McpConfig = {
    port: 0,
    host: "127.0.0.1",
    mcpToken: options.mcpToken ?? null,
    pharmallmUrl: pharma.url,
    pharmallmToken: options.pharmallmToken ?? null,
  };
  const app = createHttpApp(config, createPharmaLLMClient(pharma.url, config.pharmallmToken), silentToolLogger);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;

  const headers: Record<string, string> = {};
  if (config.mcpToken) headers.Authorization = `Bearer ${config.mcpToken}`;
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));

  return {
    pharma,
    client,
    mcpUrl,
    async close() {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pharma.close();
    },
  };
}

export function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("");
}

export function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}
```

- [ ] **Step 2: Write the failing HTTP and knowledge tool tests**

Create `mcp/__tests__/http.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import { authorizeMcpRequest } from "../src/http.js";
import { sendJson } from "./helpers/fake-pharmallm.js";
import { startHarness } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

describe("authorizeMcpRequest", () => {
  it("allows loopback without a token and refuses other addresses", () => {
    expect(authorizeMcpRequest(null, undefined, "127.0.0.1").ok).toBe(true);
    expect(authorizeMcpRequest(null, undefined, "::ffff:127.0.0.1").ok).toBe(true);
    const remote = authorizeMcpRequest(null, undefined, "192.168.50.20");
    expect(remote.ok).toBe(false);
    expect(remote.message).toContain("set MCP_TOKEN");
  });

  it("requires the token from everywhere once configured", () => {
    expect(authorizeMcpRequest("s3cret", undefined, "127.0.0.1").ok).toBe(false);
    expect(authorizeMcpRequest("s3cret", "Bearer wrong", "127.0.0.1").ok).toBe(false);
    expect(authorizeMcpRequest("s3cret", "Bearer s3cret", "192.168.50.20").ok).toBe(true);
  });
});

describe("HTTP app", () => {
  it("lists tools over MCP with the right token", async () => {
    harness = await startHarness({ mcpToken: "agent-secret" });
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_knowledge", "ask_pharmallm", "add_knowledge", "knowledge_status"])
    );
  });

  it("rejects MCP requests without the token", async () => {
    harness = await startHarness({ mcpToken: "agent-secret" });
    const resp = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(initializeBody),
    });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ error: { code: -32001 } });
  });

  it("answers GET /mcp with 405", async () => {
    harness = await startHarness();
    const resp = await fetch(harness.mcpUrl);
    expect(resp.status).toBe(405);
    expect(resp.headers.get("allow")).toBe("POST");
  });

  it("reports PharmaLLM reachability on /healthz", async () => {
    harness = await startHarness();
    harness.pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy" }));
    const resp = await fetch(harness.mcpUrl.replace("/mcp", "/healthz"));
    expect(await resp.json()).toEqual({ ok: true, pharmallm: true });
  });
});
```

Create `mcp/__tests__/knowledge-tools.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { sendJson, sendSse } from "./helpers/fake-pharmallm.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ pharmallmToken: "app-secret" });
});

afterEach(async () => {
  await harness.close();
});

describe("search_knowledge", () => {
  it("maps top_k and forwards the API token", async () => {
    harness.pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 200, { results: [{ source: "vendor-dell-cyber-recovery.md", content: "Air-gapped vault" }] })
    );

    const result = await harness.client.callTool({ name: "search_knowledge", arguments: { query: "Dell vault", top_k: 3 } });

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(toolText(result))).toEqual({
      results: [{ source: "vendor-dell-cyber-recovery.md", content: "Air-gapped vault" }],
    });
    expect(harness.pharma.requests[0].body).toEqual({ query: "Dell vault", topK: 3 });
    expect(harness.pharma.requests[0].headers.authorization).toBe("Bearer app-secret");
  });

  it("turns PharmaLLM errors into tool errors", async () => {
    harness.pharma.on("POST", "/api/knowledge/search", (_req, res) =>
      sendJson(res, 503, { error: "Search refused: index incomplete" })
    );

    const result = await harness.client.callTool({ name: "search_knowledge", arguments: { query: "x" } });

    expect(isToolError(result)).toBe(true);
    expect(toolText(result)).toBe("PharmaLLM /api/knowledge/search failed (503): Search refused: index incomplete");
    expect(harness.pharma.requests[0].body).toEqual({ query: "x", topK: 5 });
  });
});

describe("ask_pharmallm", () => {
  it("returns the collected answer", async () => {
    harness.pharma.on("POST", "/api/chat", (_req, res) =>
      sendSse(res, [
        { reasoning: "Found 1 chunk", sources: ["pharma-regulation.md"] },
        { token: "21 CFR Part 11 covers electronic records." },
        { done: true, stack: "mlx", response_id: "r-9", timings: { totalMs: 90000 } },
      ])
    );

    const result = await harness.client.callTool({ name: "ask_pharmallm", arguments: { question: "What is Part 11?" } });

    expect(JSON.parse(toolText(result))).toEqual({
      answer: "21 CFR Part 11 covers electronic records.",
      sources: ["pharma-regulation.md"],
      stack: "mlx",
      response_id: "r-9",
      timings: { totalMs: 90000 },
    });
    expect(harness.pharma.requests[0].body).toEqual({ message: "What is Part 11?", webSearch: false });
  });
});

describe("add_knowledge", () => {
  it("adds text through ingest-text", async () => {
    harness.pharma.on("POST", "/api/knowledge/ingest-text", (_req, res) => sendJson(res, 200, { added: 2 }));

    const result = await harness.client.callTool({
      name: "add_knowledge",
      arguments: { text: "Novartis opened a new SOC in Basel.", source: "analyst-note" },
    });

    expect(JSON.parse(toolText(result))).toEqual({ added: 2 });
    expect(harness.pharma.requests[0].body).toEqual({ text: "Novartis opened a new SOC in Basel.", source: "analyst-note" });
  });

  it("adds a URL through add", async () => {
    harness.pharma.on("POST", "/api/knowledge/add", (_req, res) => sendJson(res, 200, { added: 4 }));

    await harness.client.callTool({ name: "add_knowledge", arguments: { url: "https://example.com/report" } });

    expect(harness.pharma.requests[0].path).toBe("/api/knowledge/add");
    expect(harness.pharma.requests[0].body).toEqual({ url: "https://example.com/report" });
  });

  it("rejects missing or conflicting input without calling PharmaLLM", async () => {
    const neither = await harness.client.callTool({ name: "add_knowledge", arguments: { text: "no source" } });
    const both = await harness.client.callTool({
      name: "add_knowledge",
      arguments: { text: "t", source: "s", url: "https://example.com" },
    });

    expect(toolText(neither)).toBe("Provide text with a source name, or a url");
    expect(toolText(both)).toBe("Provide either text with a source, or a url, not both");
    expect(harness.pharma.requests).toHaveLength(0);
  });
});

describe("knowledge_status", () => {
  it("combines stats and ChromaDB status", async () => {
    harness.pharma.on("GET", "/api/knowledge/stats", (_req, res) => sendJson(res, 200, { totalChunks: 7626 }));
    harness.pharma.on("GET", "/api/knowledge/status", (_req, res) => sendJson(res, 200, { chromadb: "ok" }));

    const result = await harness.client.callTool({ name: "knowledge_status", arguments: {} });

    expect(JSON.parse(toolText(result))).toEqual({ stats: { totalChunks: 7626 }, status: { chromadb: "ok" } });
  });
});
```

Run: `npm --prefix mcp test -- __tests__/http.test.ts __tests__/knowledge-tools.test.ts`
Expected: FAIL with `Cannot find module '../src/http.js'` (and the harness's imports of `../../src/http.js` / `../../src/tools/result.js`).

- [ ] **Step 3: Write the tool result helpers**

Create `mcp/src/tools/result.ts`:

```ts
// Shared helpers that turn tool outcomes into MCP results and log each call

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolLogger {
  (line: string): void;
}

export const defaultToolLogger: ToolLogger = (line) => console.log(line);

export const silentToolLogger: ToolLogger = () => {};

export function textResult(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Logs name, outcome and duration only: never arguments, tokens or response bodies
export async function runTool(name: string, log: ToolLogger, fn: () => Promise<unknown>): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    log(`[mcp] ${name} ok ${Date.now() - startedAt}ms`);
    return textResult(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[mcp] ${name} error ${Date.now() - startedAt}ms`);
    return errorResult(message);
  }
}
```

- [ ] **Step 4: Write the knowledge tools, server builder and HTTP app**

Create `mcp/src/tools/knowledge.ts`:

```ts
// Knowledge base tools: search, full RAG answers, adding knowledge, status

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

export function registerKnowledgeTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "search_knowledge",
    {
      description:
        "Search PharmaLLM's knowledge base (pharma business, cyber attacks, threat actors, IT vendors, regulations) " +
        "and return the most relevant chunks with their sources. Fast: no LLM call.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for"),
        top_k: z.number().int().min(1).max(20).optional().describe("Number of chunks to return (default 5)"),
      },
    },
    async ({ query, top_k }) =>
      runTool("search_knowledge", log, () => client.post("/api/knowledge/search", { query, topK: top_k ?? 5 }))
  );

  server.registerTool(
    "ask_pharmallm",
    {
      description:
        "Ask PharmaLLM a question and get its full retrieval-augmented answer with sources, the active LLM stack " +
        "and a response_id for feedback. Runs the local 27B model and takes about 1-2 minutes.",
      inputSchema: {
        question: z.string().min(1).describe("The question to answer"),
        web_search: z.boolean().optional().describe("Also search recent news (default false)"),
      },
    },
    async ({ question, web_search }) =>
      runTool("ask_pharmallm", log, () => client.ask(question, web_search ?? false, ASK_TIMEOUT_MS))
  );

  server.registerTool(
    "add_knowledge",
    {
      description:
        "Add knowledge to PharmaLLM: either text with a source name, or a URL to fetch. " +
        "It is saved as a raw document so it survives reindexing.",
      inputSchema: {
        text: z.string().min(1).optional().describe("Text to add (requires source)"),
        source: z.string().min(1).optional().describe("Source name for the text, e.g. 'analyst-note-2026-09'"),
        url: z.url().optional().describe("URL to fetch and add instead of text"),
      },
    },
    async ({ text, source, url }) =>
      runTool("add_knowledge", log, async () => {
        if (url && text) throw new Error("Provide either text with a source, or a url, not both");
        if (url) return client.post("/api/knowledge/add", { url });
        if (text && source) return client.post("/api/knowledge/ingest-text", { text, source });
        throw new Error("Provide text with a source name, or a url");
      })
  );

  server.registerTool(
    "knowledge_status",
    { description: "Knowledge base size, sources and ChromaDB status for the active stack." },
    async () =>
      runTool("knowledge_status", log, async () => ({
        stats: await client.get("/api/knowledge/stats"),
        status: await client.get("/api/knowledge/status"),
      }))
  );
}
```

Create `mcp/src/mcp-server.ts`:

```ts
// Builds the MCP server with every PharmaLLM tool registered

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "./pharmallm-client.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import type { ToolLogger } from "./tools/result.js";

export const SERVER_INFO = { name: "pharmallm", version: "1.0.0" };

export function buildMcpServer(client: PharmaLLMClient, log: ToolLogger): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerKnowledgeTools(server, client, log);
  return server;
}
```

Create `mcp/src/http.ts`:

```ts
// HTTP host for the MCP service: token check, stateless Streamable HTTP transport, health check

import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerToken, isLoopbackAddress, tokensMatch } from "./config.js";
import type { McpConfig } from "./config.js";
import { buildMcpServer } from "./mcp-server.js";
import type { PharmaLLMClient } from "./pharmallm-client.js";
import type { ToolLogger } from "./tools/result.js";

export interface McpAuthResult {
  ok: boolean;
  message: string;
}

export function authorizeMcpRequest(
  token: string | null,
  authorization: string | undefined,
  remoteAddress: string | undefined
): McpAuthResult {
  if (token) {
    const provided = bearerToken(authorization);
    return provided !== null && tokensMatch(token, provided)
      ? { ok: true, message: "" }
      : { ok: false, message: "Unauthorized: send Authorization: Bearer <MCP_TOKEN>" };
  }
  return isLoopbackAddress(remoteAddress)
    ? { ok: true, message: "" }
    : { ok: false, message: "Unauthorized: set MCP_TOKEN to accept requests from other machines" };
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createHttpApp(config: McpConfig, client: PharmaLLMClient, log: ToolLogger): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", async (_req: Request, res: Response) => {
    let pharmallm = false;
    try {
      await client.get("/api/health", 3000);
      pharmallm = true;
    } catch {
      pharmallm = false;
    }
    res.json({ ok: true, pharmallm });
  });

  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const verdict = authorizeMcpRequest(config.mcpToken, req.headers.authorization, req.socket.remoteAddress);
    if (!verdict.ok) {
      jsonRpcError(res, 401, -32001, verdict.message);
      return;
    }
    next();
  });

  // Stateless: a fresh server and transport per request, no sessions to keep
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildMcpServer(client, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`[mcp] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed");
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed");
  });

  return app;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: PASS — config 7, client 9, http 6, knowledge tools 7 (29 tests); typecheck exit 0; no open-handle warning.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/tools/result.ts mcp/src/tools/knowledge.ts mcp/src/mcp-server.ts mcp/src/http.ts mcp/__tests__/helpers/harness.ts mcp/__tests__/http.test.ts mcp/__tests__/knowledge-tools.test.ts
git commit -m "feat: serve PharmaLLM knowledge tools over authenticated MCP HTTP

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Graph, gap, operations and feedback tools; entry point

**Files:**
- Create: `mcp/src/tools/graph.ts`, `mcp/src/tools/gaps.ts`, `mcp/src/tools/operations.ts`, `mcp/src/tools/feedback.ts`, `mcp/src/server.ts`, `mcp/__tests__/other-tools.test.ts`, `mcp/README.md`
- Modify: `mcp/src/mcp-server.ts` (full replacement below)

**Interfaces:**
- Consumes: `runTool`, `ToolLogger`, `defaultToolLogger` (Task 3); `PharmaLLMClient`, `createPharmaLLMClient` (Task 2); `loadConfig`, `McpConfig` (Task 1); `createHttpApp` (Task 3); harness helpers (Task 3).
- Produces:
  - `registerGraphTools`, `registerGapTools`, `registerOperationsTools`, `registerFeedbackTools` — each `(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void`
  - `mcp/src/tools/operations.ts`: `const NEWS_AGENT_TIMEOUT_MS = 900_000`
  - Tool names (final set of 16): `search_knowledge`, `ask_pharmallm`, `add_knowledge`, `knowledge_status`, `graph_search`, `graph_stats`, `list_knowledge_gaps`, `resolve_knowledge_gap`, `system_health`, `dashboard_metrics`, `run_news_agent`, `news_agent_status`, `start_reindex`, `reindex_status`, `record_feedback`, `feedback_report`
  - PharmaLLM routes the reindex tools rely on (implemented in Task 7): `POST /api/knowledge/reindex` → `202 { job_id, status }`, `GET /api/knowledge/reindex/status`

- [ ] **Step 1: Write the failing tests**

Create `mcp/__tests__/other-tools.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { sendJson } from "./helpers/fake-pharmallm.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return harness.client.callTool({ name, arguments: args });
}

describe("tool list", () => {
  it("exposes exactly the 16 PharmaLLM tools", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_knowledge",
      "ask_pharmallm",
      "dashboard_metrics",
      "feedback_report",
      "graph_search",
      "graph_stats",
      "knowledge_status",
      "list_knowledge_gaps",
      "news_agent_status",
      "record_feedback",
      "reindex_status",
      "resolve_knowledge_gap",
      "run_news_agent",
      "search_knowledge",
      "start_reindex",
      "system_health",
    ]);
  });
});

describe("graph tools", () => {
  it("searches an entity by name", async () => {
    harness.pharma.on("POST", "/api/graph/search", (_req, res) => sendJson(res, 200, { results: [{ name: "LockBit" }] }));

    const result = await call("graph_search", { entity: "LockBit" });

    expect(JSON.parse(toolText(result))).toEqual({ results: [{ name: "LockBit" }] });
    expect(harness.pharma.requests[0].body).toEqual({ name: "LockBit" });
  });

  it("returns graph stats", async () => {
    harness.pharma.on("GET", "/api/graph/stats", (_req, res) => sendJson(res, 200, { nodeCount: 498 }));
    expect(JSON.parse(toolText(await call("graph_stats")))).toEqual({ nodeCount: 498 });
  });
});

describe("gap tools", () => {
  it("lists gaps filtered by status with stats", async () => {
    harness.pharma.on("GET", "/api/knowledge/gaps", (_req, res) =>
      sendJson(res, 200, {
        gaps: [
          { id: 1, status: "resolved" },
          { id: 2, status: "detected" },
        ],
      })
    );
    harness.pharma.on("GET", "/api/knowledge/gaps/stats", (_req, res) => sendJson(res, 200, { total: 2 }));

    const result = await call("list_knowledge_gaps", { status: "detected" });

    expect(JSON.parse(toolText(result))).toEqual({ gaps: [{ id: 2, status: "detected" }], stats: { total: 2 } });
  });

  it("resolves a gap", async () => {
    harness.pharma.on("POST", "/api/knowledge/gaps/check-resolution", (_req, res) =>
      sendJson(res, 200, { resolved: true, new_response: "…", confidence_reason: "specific" })
    );

    await call("resolve_knowledge_gap", { gap_id: 7, original_query: "Who attacked Merck?" });

    expect(harness.pharma.requests[0].body).toEqual({ gap_id: 7, original_query: "Who attacked Merck?" });
  });
});

describe("operations tools", () => {
  it("maps health, metrics and news agent status to GET routes", async () => {
    harness.pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy", stack: "ollama" }));
    harness.pharma.on("GET", "/api/dashboard/metrics", (_req, res) => sendJson(res, 200, { questions_7d: 12 }));
    harness.pharma.on("GET", "/api/agent/status", (_req, res) => sendJson(res, 200, { isRunning: false }));

    expect(JSON.parse(toolText(await call("system_health")))).toEqual({ status: "healthy", stack: "ollama" });
    expect(JSON.parse(toolText(await call("dashboard_metrics")))).toEqual({ questions_7d: 12 });
    expect(JSON.parse(toolText(await call("news_agent_status")))).toEqual({ isRunning: false });
  });

  it("runs the news agent", async () => {
    harness.pharma.on("POST", "/api/agent/run", (_req, res) => sendJson(res, 200, { newArticles: 3, topics: 188 }));
    expect(JSON.parse(toolText(await call("run_news_agent")))).toEqual({ newArticles: 3, topics: 188 });
  });

  it("starts a reindex and reports its status", async () => {
    harness.pharma.on("POST", "/api/knowledge/reindex", (_req, res) => sendJson(res, 202, { job_id: "j-1", status: "running" }));
    harness.pharma.on("GET", "/api/knowledge/reindex/status", (_req, res) =>
      sendJson(res, 200, { job_id: "j-1", status: "running", progress: { raw_documents_done: 64, raw_documents_total: 7023 } })
    );

    expect(JSON.parse(toolText(await call("start_reindex")))).toEqual({ job_id: "j-1", status: "running" });
    expect(JSON.parse(toolText(await call("reindex_status")))).toMatchObject({ status: "running" });
  });

  it("surfaces a 409 when a reindex is already running", async () => {
    harness.pharma.on("POST", "/api/knowledge/reindex", (_req, res) => sendJson(res, 409, { error: "A reindex is already running" }));

    const result = await call("start_reindex");

    expect(isToolError(result)).toBe(true);
    expect(toolText(result)).toBe("PharmaLLM /api/knowledge/reindex failed (409): A reindex is already running");
  });
});

describe("feedback tools", () => {
  it("records feedback", async () => {
    harness.pharma.on("POST", "/api/feedback", (_req, res) => sendJson(res, 200, { id: 42 }));

    await call("record_feedback", { rating: 4, response_id: "r-9", comment: "Good sources" });

    expect(harness.pharma.requests[0].body).toEqual({ rating: 4, response_id: "r-9", comment: "Good sources" });
  });

  it("rejects an out-of-range rating before calling PharmaLLM", async () => {
    const result = await call("record_feedback", { rating: 9 });
    expect(isToolError(result)).toBe(true);
    expect(harness.pharma.requests).toHaveLength(0);
  });

  it("maps report kinds to routes", async () => {
    harness.pharma.on("GET", "/api/feedback/weekly-digest", (_req, res) => sendJson(res, 200, { week: "ok" }));
    expect(JSON.parse(toolText(await call("feedback_report", { kind: "weekly_digest" })))).toEqual({ week: "ok" });
  });
});
```

Run: `npm --prefix mcp test -- __tests__/other-tools.test.ts`
Expected: FAIL — the tool list has only 4 tools and the new tools are unknown (`MCP error -32602: Tool graph_search not found` or similar).

- [ ] **Step 2: Implement the tool groups**

Create `mcp/src/tools/graph.ts`:

```ts
// Knowledge graph tools (Neo4j via PharmaLLM)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export function registerGraphTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "graph_search",
    {
      description:
        "Look up an entity in PharmaLLM's knowledge graph (company, drug, threat actor, attack, vendor, regulation…) " +
        "and return it with its neighbours and relationships.",
      inputSchema: { entity: z.string().min(1).describe("Entity name, e.g. 'LockBit' or 'Novartis'") },
    },
    async ({ entity }) => runTool("graph_search", log, () => client.post("/api/graph/search", { name: entity }))
  );

  server.registerTool(
    "graph_stats",
    { description: "Knowledge graph size: node counts by label and relationship counts by type." },
    async () => runTool("graph_stats", log, () => client.get("/api/graph/stats"))
  );
}
```

Create `mcp/src/tools/gaps.ts`:

```ts
// Knowledge gap tools: low-confidence questions and their resolution

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

function gapsOf(payload: unknown): Array<Record<string, unknown>> {
  const gaps = typeof payload === "object" && payload !== null ? (payload as { gaps?: unknown }).gaps : undefined;
  return Array.isArray(gaps) ? gaps.filter((gap): gap is Record<string, unknown> => typeof gap === "object" && gap !== null) : [];
}

export function registerGapTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "list_knowledge_gaps",
    {
      description: "Recent questions PharmaLLM answered with low confidence, with overall gap statistics.",
      inputSchema: {
        status: z.enum(["detected", "resolved", "unresolved"]).optional().describe("Only gaps with this status"),
      },
    },
    async ({ status }) =>
      runTool("list_knowledge_gaps", log, async () => {
        const gaps = gapsOf(await client.get("/api/knowledge/gaps"));
        return {
          gaps: status ? gaps.filter((gap) => gap.status === status) : gaps,
          stats: await client.get("/api/knowledge/gaps/stats"),
        };
      })
  );

  server.registerTool(
    "resolve_knowledge_gap",
    {
      description:
        "Re-ask a knowledge gap's question through PharmaLLM's RAG pipeline and mark the gap resolved if the new " +
        "answer is confident. Use after adding knowledge for that topic. Takes about 1-2 minutes.",
      inputSchema: {
        gap_id: z.number().int().positive(),
        original_query: z.string().min(1),
        search_topic: z.string().min(1).optional(),
      },
    },
    async ({ gap_id, original_query, search_topic }) =>
      runTool("resolve_knowledge_gap", log, () =>
        client.post(
          "/api/knowledge/gaps/check-resolution",
          search_topic ? { gap_id, original_query, search_topic } : { gap_id, original_query },
          5 * 60 * 1000
        )
      )
  );
}
```

Create `mcp/src/tools/operations.ts`:

```ts
// Operations tools: health, metrics, news agent, background reindex

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export const NEWS_AGENT_TIMEOUT_MS = 15 * 60 * 1000;

export function registerOperationsTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "system_health",
    { description: "PharmaLLM health: active LLM stack, chat/embedding/index checks, supporting services, benchmark mode." },
    async () => runTool("system_health", log, () => client.get("/api/health"))
  );

  server.registerTool(
    "dashboard_metrics",
    { description: "Usage and quality metrics: questions, confidence, response times, gaps, knowledge base health." },
    async () => runTool("dashboard_metrics", log, () => client.get("/api/dashboard/metrics"))
  );

  server.registerTool(
    "run_news_agent",
    {
      description:
        "Run PharmaLLM's news agent now: pulls pharma and cyber news for about 190 topics into the knowledge base. " +
        "Takes several minutes and uses the GPU.",
    },
    async () => runTool("run_news_agent", log, () => client.post("/api/agent/run", {}, NEWS_AGENT_TIMEOUT_MS))
  );

  server.registerTool(
    "news_agent_status",
    { description: "Whether the news agent is running, its last run and its schedule." },
    async () => runTool("news_agent_status", log, () => client.get("/api/agent/status"))
  );

  server.registerTool(
    "start_reindex",
    {
      description:
        "Start rebuilding the active stack's search indexes in the background (12-16 minutes, GPU-heavy; search is " +
        "refused while it runs). Returns a job id; poll reindex_status.",
    },
    async () => runTool("start_reindex", log, () => client.post("/api/knowledge/reindex", {}))
  );

  server.registerTool(
    "reindex_status",
    { description: "State and progress of the most recent background reindex." },
    async () => runTool("reindex_status", log, () => client.get("/api/knowledge/reindex/status"))
  );
}
```

Create `mcp/src/tools/feedback.ts`:

```ts
// Feedback tools: rate answers and read feedback reports

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

const REPORT_ROUTES = {
  stats: "/api/feedback/stats",
  low_rated: "/api/feedback/low-rated",
  weekly_digest: "/api/feedback/weekly-digest",
} as const;

export function registerFeedbackTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "record_feedback",
    {
      description: "Rate a PharmaLLM answer from 1 (poor) to 5 (excellent), using the response_id from ask_pharmallm.",
      inputSchema: {
        rating: z.number().int().min(1).max(5),
        response_id: z.string().min(1).optional(),
        comment: z.string().min(1).optional(),
      },
    },
    async ({ rating, response_id, comment }) =>
      runTool("record_feedback", log, () =>
        client.post("/api/feedback", {
          rating,
          ...(response_id ? { response_id } : {}),
          ...(comment ? { comment } : {}),
        })
      )
  );

  server.registerTool(
    "feedback_report",
    {
      description: "Feedback overview: rating stats, low-rated answers, or the weekly digest.",
      inputSchema: { kind: z.enum(["stats", "low_rated", "weekly_digest"]) },
    },
    async ({ kind }) => runTool("feedback_report", log, () => client.get(REPORT_ROUTES[kind]))
  );
}
```

Replace `mcp/src/mcp-server.ts` with:

```ts
// Builds the MCP server with every PharmaLLM tool registered

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "./pharmallm-client.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerGapTools } from "./tools/gaps.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerOperationsTools } from "./tools/operations.js";
import type { ToolLogger } from "./tools/result.js";

export const SERVER_INFO = { name: "pharmallm", version: "1.0.0" };

export function buildMcpServer(client: PharmaLLMClient, log: ToolLogger): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerKnowledgeTools(server, client, log);
  registerGraphTools(server, client, log);
  registerGapTools(server, client, log);
  registerOperationsTools(server, client, log);
  registerFeedbackTools(server, client, log);
  return server;
}
```

- [ ] **Step 3: Run the tests**

Run: `npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: PASS — 29 earlier tests plus 12 in `other-tools.test.ts` (41 tests); typecheck exit 0.

- [ ] **Step 4: Add the entry point**

Create `mcp/src/server.ts`:

```ts
// Entry point: starts the PharmaLLM MCP service

import { loadConfig } from "./config.js";
import type { McpConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { createPharmaLLMClient } from "./pharmallm-client.js";
import { defaultToolLogger } from "./tools/result.js";

function main(): void {
  let config: McpConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`pharmallm-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const client = createPharmaLLMClient(config.pharmallmUrl, config.pharmallmToken);
  const app = createHttpApp(config, client, defaultToolLogger);
  app.listen(config.port, config.host, () => {
    console.log(`pharmallm-mcp listening on http://${config.host}:${config.port}/mcp -> PharmaLLM at ${config.pharmallmUrl}`);
    console.log(config.mcpToken ? "MCP token required" : "No MCP_TOKEN: accepting loopback requests only");
  });
}

main();
```

Smoke-check start-up behaviour (the health check is a read-only GET to the running app):

```bash
cd mcp
MCP_HOST=0.0.0.0 node --import tsx src/server.ts; echo "exit=$?"
MCP_PORT=3299 node --import tsx src/server.ts > ../data/logs/mcp-smoke.log 2>&1 &
SMOKE_PID=$!
sleep 3; curl -s http://127.0.0.1:3299/healthz; echo; curl -s -o /dev/null -w "GET /mcp -> %{http_code}\n" http://127.0.0.1:3299/mcp
kill "$SMOKE_PID"; sleep 1; cat ../data/logs/mcp-smoke.log; cd ..
```

Expected:
- First command prints `pharmallm-mcp: MCP_TOKEN is required when MCP_HOST (0.0.0.0) is not a loopback address` and `exit=1`.
- `/healthz` returns `{"ok":true,"pharmallm":false}` or `{"ok":true,"pharmallm":true}` depending on whether the running app's `/api/health` answers; `GET /mcp -> 405`.
- The log shows `pharmallm-mcp listening on http://127.0.0.1:3299/mcp` and `No MCP_TOKEN: accepting loopback requests only`.

Only the smoke process (by its PID) is stopped; never kill processes by name pattern, because the PharmaLLM app also runs `tsx src/server.ts`. Confirm `lsof -iTCP:3299 -sTCP:LISTEN` prints nothing and `curl -s localhost:3000/api/health` still answers.

- [ ] **Step 5: Write the package README**

Create `mcp/README.md`:

````markdown
# pharmallm-mcp

MCP service that exposes PharmaLLM to AI agents (Hermes Agent, Claude Desktop, any MCP client) over Streamable HTTP. It holds no RAG logic: every tool calls PharmaLLM's REST API.

## Run

```bash
npm --prefix mcp install
npm --prefix mcp start          # http://127.0.0.1:3200/mcp
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_PORT` | `3200` | Listen port |
| `MCP_HOST` | `127.0.0.1` | Bind address; use a LAN or Tailscale IP to serve another machine |
| `MCP_TOKEN` | *(none)* | Bearer token agents must send; required when `MCP_HOST` is not loopback |
| `PHARMALLM_URL` | `http://localhost:3000` | PharmaLLM base URL |
| `PHARMALLM_API_TOKEN` | *(none)* | PharmaLLM API token (see `scripts/switch-stack.sh token`) |

Without `MCP_TOKEN` the service only accepts requests from the same machine.

## Tools

| Tool | Purpose |
|------|---------|
| `search_knowledge` | Top chunks and sources for a query (fast) |
| `ask_pharmallm` | Full RAG answer with sources (~1-2 min) |
| `add_knowledge` | Add text (with source) or a URL |
| `knowledge_status` | Knowledge base and ChromaDB status |
| `graph_search`, `graph_stats` | Knowledge graph lookup and size |
| `list_knowledge_gaps`, `resolve_knowledge_gap` | Low-confidence questions and re-checks |
| `system_health`, `dashboard_metrics` | Stack, services, usage metrics |
| `run_news_agent`, `news_agent_status` | Trigger or inspect the news scrub |
| `start_reindex`, `reindex_status` | Background index rebuild |
| `record_feedback`, `feedback_report` | Rate answers, feedback reports |

## Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  pharmallm:
    url: "http://localhost:3200/mcp"
    headers:
      Authorization: "Bearer ${PHARMALLM_MCP_TOKEN}"
    timeout: 900
```

The long timeout covers `run_news_agent`. When Hermes runs on another Mac, start this service with `MCP_HOST` set to the model Mac's LAN or Tailscale address and `MCP_TOKEN`, and use that address in `url`.

## Tests

```bash
npm --prefix mcp test
npm --prefix mcp run typecheck
```
````

- [ ] **Step 6: Commit**

```bash
git add mcp/src/tools/graph.ts mcp/src/tools/gaps.ts mcp/src/tools/operations.ts mcp/src/tools/feedback.ts mcp/src/mcp-server.ts mcp/src/server.ts mcp/__tests__/other-tools.test.ts mcp/README.md
git commit -m "feat: add graph, gap, operations and feedback MCP tools and service entry point

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: PharmaLLM API token authentication

**Files:**
- Create: `src/api/auth.ts`, `__tests__/auth.test.ts`
- Modify: `src/server.ts` (mount middleware), `scripts/benchmark-stack.ts` (send token)

**Interfaces:**
- Produces (`src/api/auth.ts`):
  - `const BROWSER_ROUTES: ReadonlyArray<readonly [string, string]>` (method, path)
  - `isLoopbackAddress(address: string | undefined): boolean`
  - `bearerToken(authorization: string | undefined): string | null`
  - `tokensMatch(expected: string, provided: string): boolean`
  - `isProtectedRequest(method: string, path: string): boolean`
  - `interface AuthRequest { method: string; path: string; authorization: string | undefined; remoteAddress: string | undefined }`
  - `interface AuthDecision { ok: boolean; message: string }`
  - `authorizeRequest(request: AuthRequest, token: string | null): AuthDecision`
  - `readApiToken(env?: NodeJS.ProcessEnv): string | null`
  - `createAuthMiddleware(getToken?: () => string | null): RequestHandler`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/auth.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authorizeRequest,
  bearerToken,
  createAuthMiddleware,
  isProtectedRequest,
  readApiToken,
  tokensMatch,
} from "../src/api/auth.js";

const loopback = "127.0.0.1";
const lan = "192.168.50.20";

describe("isProtectedRequest", () => {
  it("keeps browser UI routes and static pages open", () => {
    expect(isProtectedRequest("POST", "/api/chat")).toBe(false);
    expect(isProtectedRequest("GET", "/api/health")).toBe(false);
    expect(isProtectedRequest("POST", "/api/knowledge/upload")).toBe(false);
    expect(isProtectedRequest("GET", "/api/chat/models/")).toBe(false);
    expect(isProtectedRequest("GET", "/")).toBe(false);
    expect(isProtectedRequest("GET", "/dashboard/index.html")).toBe(false);
  });

  it("protects everything else under /api and all of /v1", () => {
    expect(isProtectedRequest("POST", "/api/knowledge/reindex")).toBe(true);
    expect(isProtectedRequest("POST", "/api/llm/complete")).toBe(true);
    expect(isProtectedRequest("GET", "/api/bench/status")).toBe(true);
    expect(isProtectedRequest("GET", "/api/knowledge/search")).toBe(true); // only POST is a browser route
    expect(isProtectedRequest("POST", "/v1/chat/completions")).toBe(true);
    expect(isProtectedRequest("GET", "/v1/models")).toBe(true);
  });
});

describe("authorizeRequest", () => {
  const reindex = { method: "POST", path: "/api/knowledge/reindex" };

  it("allows protected routes from loopback when no token is configured", () => {
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback }, null).ok).toBe(true);
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: "::ffff:127.0.0.1" }, null).ok).toBe(true);
  });

  it("refuses protected routes from other machines when no token is configured", () => {
    const decision = authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: lan }, null);
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain("PHARMALLM_API_TOKEN");
  });

  it("requires the token from everywhere once configured", () => {
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback }, "s3cret").ok).toBe(false);
    expect(authorizeRequest({ ...reindex, authorization: "Bearer nope", remoteAddress: lan }, "s3cret").ok).toBe(false);
    expect(authorizeRequest({ ...reindex, authorization: "Bearer s3cret", remoteAddress: lan }, "s3cret").ok).toBe(true);
  });

  it("never blocks browser routes", () => {
    expect(authorizeRequest({ method: "POST", path: "/api/chat", authorization: undefined, remoteAddress: lan }, "s3cret").ok).toBe(true);
  });
});

describe("token helpers", () => {
  it("parses bearer tokens, compares safely and reads the environment", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(readApiToken({ PHARMALLM_API_TOKEN: "  t0ken " })).toBe("t0ken");
    expect(readApiToken({ PHARMALLM_API_TOKEN: "" })).toBeNull();
    expect(readApiToken({})).toBeNull();
  });
});

describe("createAuthMiddleware", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  async function start(token: string | null): Promise<string> {
    const app = express();
    app.use(createAuthMiddleware(() => token));
    app.post("/api/knowledge/reindex", (_req, res) => {
      res.json({ ok: true });
    });
    app.post("/api/chat", (_req, res) => {
      res.json({ ok: true });
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("returns 401 JSON without the token and passes with it", async () => {
    const url = await start("s3cret");

    const denied = await fetch(`${url}/api/knowledge/reindex`, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "Unauthorized: send Authorization: Bearer <PHARMALLM_API_TOKEN>" });

    const allowed = await fetch(`${url}/api/knowledge/reindex`, {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);

    const browser = await fetch(`${url}/api/chat`, { method: "POST" });
    expect(browser.status).toBe(200);
  });

  it("lets loopback through without a configured token", async () => {
    const url = await start(null);
    const resp = await fetch(`${url}/api/knowledge/reindex`, { method: "POST" });
    expect(resp.status).toBe(200);
  });
});
```

Run: `npm run test -- __tests__/auth.test.ts`
Expected: FAIL with `Cannot find module '../src/api/auth.js'`.

- [ ] **Step 2: Implement the auth module**

Create `src/api/auth.ts`:

```ts
// API token authentication: protects agent and operations routes, keeps browser UI routes open

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

// Routes the chat UI and dashboard call from the browser (method, path); these stay open
export const BROWSER_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/api/chat"],
  ["GET", "/api/chat/models"],
  ["POST", "/api/chat/transcribe"],
  ["POST", "/api/knowledge/search"],
  ["GET", "/api/knowledge/stats"],
  ["POST", "/api/knowledge/upload"],
  ["POST", "/api/knowledge/ingest-text"],
  ["POST", "/api/agent/run"],
  ["GET", "/api/agent/status"],
  ["GET", "/api/dashboard/metrics"],
  ["GET", "/api/dashboard/chromadb-misses"],
  ["GET", "/api/graph/stats"],
  ["GET", "/api/health"],
];

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface AuthRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  remoteAddress: string | undefined;
}

export interface AuthDecision {
  ok: boolean;
  message: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Hash both sides first so timingSafeEqual always compares equal-length buffers
export function tokensMatch(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function isProtectedRequest(method: string, path: string): boolean {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalized === "/v1" || normalized.startsWith("/v1/")) return true;
  if (!normalized.startsWith("/api/")) return false;
  const upper = method.toUpperCase();
  return !BROWSER_ROUTES.some(([routeMethod, routePath]) => routeMethod === upper && routePath === normalized);
}

export function authorizeRequest(request: AuthRequest, token: string | null): AuthDecision {
  if (!isProtectedRequest(request.method, request.path)) return { ok: true, message: "" };

  if (token) {
    const provided = bearerToken(request.authorization);
    return provided !== null && tokensMatch(token, provided)
      ? { ok: true, message: "" }
      : { ok: false, message: "Unauthorized: send Authorization: Bearer <PHARMALLM_API_TOKEN>" };
  }

  // No token configured: operations stay local-only
  return isLoopbackAddress(request.remoteAddress)
    ? { ok: true, message: "" }
    : {
        ok: false,
        message: "Unauthorized: set PHARMALLM_API_TOKEN (scripts/switch-stack.sh token) to allow requests from other machines",
      };
}

export function readApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PHARMALLM_API_TOKEN?.trim() || null;
}

export function createAuthMiddleware(getToken: () => string | null = () => readApiToken()): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = authorizeRequest(
      {
        method: req.method,
        path: req.path,
        authorization: req.headers.authorization,
        remoteAddress: req.socket.remoteAddress,
      },
      getToken()
    );
    if (!decision.ok) {
      res.status(401).json({ error: decision.message });
      return;
    }
    next();
  };
}
```

- [ ] **Step 3: Run the tests**

Run: `npm run test -- __tests__/auth.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 4: Mount the middleware**

In `src/server.ts`, add below `import llmRouter from "./api/llm.js";`:

```ts
import { createAuthMiddleware } from "./api/auth.js";
```

and replace:

```ts
// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.static(join(process.cwd(), "public")));
```

with:

```ts
// Middleware
app.use(express.json({ limit: "10mb" }));
// Token check for agent and operations routes (browser UI routes and static files stay open)
app.use(createAuthMiddleware());
app.use(express.static(join(process.cwd(), "public")));
```

- [ ] **Step 5: Send the token from the benchmark runner**

In `scripts/benchmark-stack.ts`, add below `import { join } from "node:path";`:

```ts
import { existsSync, readFileSync } from "node:fs";
```

Add below the imports:

```ts
// Benchmark routes (/api/bench/*) are protected: send the API token when one is configured
function apiToken(): string | null {
  const fromEnv = process.env.PHARMALLM_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const tokenFile = join(process.cwd(), "data", "run", "api-token");
  return existsSync(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() || null : null;
}

const AUTH_HEADERS: Record<string, string> = (() => {
  const token = apiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
})();
```

Replace in `getJson`:

```ts
  const resp = await fetch(url, { method, signal });
```

with:

```ts
  const resp = await fetch(url, { method, signal, headers: AUTH_HEADERS });
```

Replace in `ask`:

```ts
      headers: { "Content-Type": "application/json" },
```

with:

```ts
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
```

- [ ] **Step 6: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; 101 existing tests + 9 auth tests pass (110).

```bash
git add src/api/auth.ts __tests__/auth.test.ts src/server.ts scripts/benchmark-stack.ts
git commit -m "feat: protect agent and operations routes with an API token

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: OpenAI-compatible model gateway (`/v1`)

**Files:**
- Create: `src/services/model-gateway.ts`, `src/api/v1.ts`, `__tests__/model-gateway.test.ts`
- Modify: `src/server.ts` (mount `/v1`)

**Interfaces:**
- Consumes: `StackConfig`, `buildStacks` (`src/config/llm-stacks.ts`); `StackUnavailableError`, `getLlmClient` (`src/services/llm-client.ts`); `isBenchmarkActive`, `trackJob` (`src/services/bench-mode.ts`); root test helper `startFakeServer`, `sendJson`, `sendSse` (`__tests__/helpers/fake-openai-server.ts`); auth middleware from Task 5 protects `/v1`.
- Produces (`src/services/model-gateway.ts`):
  - `const GATEWAY_MAX_TOKENS = 4096`
  - `class GatewayError extends Error { readonly status: number; readonly type: string }`
  - `interface OpenAiErrorBody { error: { message: string; type: string } }`, `openAiError(message: string, type: string): OpenAiErrorBody`
  - `buildUpstreamBody(body: unknown, stack: StackConfig): Record<string, unknown>`
  - `modelList(stack: StackConfig): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> }`
  - `interface GatewayDeps { stack: StackConfig; fetchImpl: typeof fetch; isBenchmarkActive: () => boolean; trackJob: <T>(name: string, job: () => Promise<T>) => Promise<T> }`
  - `forwardChatCompletion(body: unknown, res: express.Response, deps: GatewayDeps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/model-gateway.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildStacks } from "../src/config/llm-stacks.js";
import type { StackConfig } from "../src/config/llm-stacks.js";
import { buildUpstreamBody, forwardChatCompletion, GatewayError, modelList } from "../src/services/model-gateway.js";
import type { GatewayDeps } from "../src/services/model-gateway.js";
import { sendJson, sendSse, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

const CLOSED_URL = "http://127.0.0.1:9";

function mlxStackAt(url: string): StackConfig {
  return { ...buildStacks({}).mlx, chatBaseUrl: url, embedBaseUrl: url };
}

let upstream: FakeServer | null = null;
let gateway: Server | null = null;

afterEach(async () => {
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    gateway = null;
  }
  await upstream?.close();
  upstream = null;
});

async function startGateway(overrides: Partial<GatewayDeps> & { stack: StackConfig }): Promise<string> {
  const deps: GatewayDeps = {
    fetchImpl: fetch,
    isBenchmarkActive: () => false,
    trackJob: async <T>(_name: string, job: () => Promise<T>) => job(),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.post("/v1/chat/completions", (req, res) => {
    void forwardChatCompletion(req.body, res, deps);
  });
  gateway = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1/chat/completions`;
}

const toolRequest = {
  model: "gpt-4o",
  n: 3,
  messages: [{ role: "user", content: "Weather in Basel?" }],
  tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
  tool_choice: "auto",
};

describe("buildUpstreamBody", () => {
  const mlx = buildStacks({}).mlx;

  it("forces the stack model, merges the stack's extra body and passes tool fields", () => {
    expect(buildUpstreamBody(toolRequest, mlx)).toEqual({
      messages: toolRequest.messages,
      tools: toolRequest.tools,
      tool_choice: "auto",
      max_tokens: 4096,
      model: "mlx-community/Qwen3.8-27B-4bit",
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("keeps smaller max_tokens and caps larger ones", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(buildUpstreamBody({ messages, max_tokens: 512 }, mlx).max_tokens).toBe(512);
    expect(buildUpstreamBody({ messages, max_tokens: 100000 }, mlx).max_tokens).toBe(4096);
  });

  it("rejects a request without messages", () => {
    expect(() => buildUpstreamBody({ model: "x" }, mlx)).toThrow(GatewayError);
    expect(() => buildUpstreamBody({ messages: [] }, mlx)).toThrow("messages must be a non-empty array");
  });

  it("lists only the stack's chat model", () => {
    expect(modelList(mlx)).toEqual({
      object: "list",
      data: [{ id: "mlx-community/Qwen3.8-27B-4bit", object: "model", created: 0, owned_by: "pharmallm" }],
    });
  });
});

describe("forwardChatCompletion", () => {
  it("passes a non-streaming tool call response through", async () => {
    const completion = {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function" }] } }],
    };
    upstream = await startFakeServer((_req, res) => sendJson(res, 200, completion));
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl) });

    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toolRequest) });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(completion);
    expect(upstream.requests[0].url).toBe("/v1/chat/completions");
    expect((upstream.requests[0].body as { model: string }).model).toBe("mlx-community/Qwen3.8-27B-4bit");
  });

  it("streams server-sent events through unchanged", async () => {
    upstream = await startFakeServer((_req, res) =>
      sendSse(res, [{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }])
    );
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl) });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const text = await resp.text();

    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('data: {"choices":[{"delta":{"content":"Hel"}}]}');
    expect(text).toContain('data: {"choices":[{"delta":{"content":"lo"}}]}');
    expect(text).toContain("data: [DONE]");
  });

  it("passes upstream error statuses through", async () => {
    upstream = await startFakeServer((_req, res) => sendJson(res, 500, { error: { message: "model crashed" } }));
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl) });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: { message: "model crashed" } });
  });

  it("refuses during benchmark mode without calling the stack", async () => {
    upstream = await startFakeServer((_req, res) => sendJson(res, 200, {}));
    const url = await startGateway({ stack: mlxStackAt(upstream.baseUrl), isBenchmarkActive: () => true });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({
      error: { message: "Benchmark in progress — try again after it finishes", type: "service_unavailable" },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("returns 503 when the stack is down and tracks the job", async () => {
    const jobs: string[] = [];
    const url = await startGateway({
      stack: mlxStackAt(CLOSED_URL),
      trackJob: async <T>(name: string, job: () => Promise<T>) => {
        jobs.push(name);
        return job();
      },
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { error: { message: string } }).error.message).toContain("MLX stack not reachable");
    expect(jobs).toEqual(["agent-completion"]);
  });

  it("returns 400 for an invalid request", async () => {
    const url = await startGateway({ stack: mlxStackAt(CLOSED_URL) });

    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({
      error: { message: "messages must be a non-empty array", type: "invalid_request_error" },
    });
  });
});
```

Run: `npm run test -- __tests__/model-gateway.test.ts`
Expected: FAIL with `Cannot find module '../src/services/model-gateway.js'`.

- [ ] **Step 2: Implement the gateway service**

Create `src/services/model-gateway.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests**

Run: `npm run test -- __tests__/model-gateway.test.ts`
Expected: PASS, 10 tests, no open-handle warning.

- [ ] **Step 4: Add and mount the router**

Create `src/api/v1.ts`:

```ts
// OpenAI-compatible endpoints so agents use PharmaLLM's active LLM stack

import { Router } from "express";
import type { Request, Response } from "express";
import { getLlmClient } from "../services/llm-client.js";
import { isBenchmarkActive, trackJob } from "../services/bench-mode.js";
import { forwardChatCompletion, modelList, openAiError } from "../services/model-gateway.js";

const router = Router();

// GET /v1/models - The active stack's chat model (503 when the stack is down)
router.get("/models", async (_req: Request, res: Response): Promise<void> => {
  const llm = getLlmClient();
  try {
    await llm.listModels();
    res.json(modelList(llm.stack));
  } catch (err) {
    res.status(503).json(openAiError(err instanceof Error ? err.message : "LLM stack unavailable", "service_unavailable"));
  }
});

// POST /v1/chat/completions - Forwarded to the active stack (tools and streaming supported)
router.post("/chat/completions", async (req: Request, res: Response): Promise<void> => {
  const llm = getLlmClient();
  await forwardChatCompletion(req.body, res, {
    stack: llm.stack,
    fetchImpl: fetch,
    isBenchmarkActive: () => isBenchmarkActive(),
    trackJob,
  });
});

export default router;
```

In `src/server.ts`, add below `import { createAuthMiddleware } from "./api/auth.js";`:

```ts
import v1Router from "./api/v1.js";
```

and add below `app.use("/api/llm", llmRouter);`:

```ts
app.use("/v1", v1Router);
```

- [ ] **Step 5: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; 110 + 10 = 120 tests pass.

```bash
git add src/services/model-gateway.ts src/api/v1.ts __tests__/model-gateway.test.ts src/server.ts
git commit -m "feat: add OpenAI-compatible /v1 gateway to the active LLM stack

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Asynchronous reindex jobs

**Files:**
- Create: `src/services/reindex-jobs.ts`, `__tests__/reindex-jobs.test.ts`
- Modify: `src/services/reindex.ts` (progress callback), `src/api/knowledge.ts` (async routes), `__tests__/reindex.test.ts` (progress assertion)

**Interfaces:**
- Consumes: `reindexActiveStack(log, deps?, onProgress?)`, `ReindexResult`, `ReindexDeps` (`src/services/reindex.ts`); `trackJob`, `getRunningJobs`, `isBenchmarkActive` (`src/services/bench-mode.ts`).
- Produces:
  - `src/services/reindex.ts`: `interface ReindexProgress { rawDocumentsDone: number; rawDocumentsTotal: number }`; `reindexActiveStack(log?, deps?, onProgress?: (progress: ReindexProgress) => void): Promise<ReindexResult>`
  - `src/services/reindex-jobs.ts`: `interface ReindexJobStatus { job_id: string | null; status: "idle" | "running" | "succeeded" | "failed"; started_at?: string; finished_at?: string; progress?: { raw_documents_done: number; raw_documents_total: number }; result?: ReindexResult; error?: string }`, `interface ReindexRunner { (onProgress: (progress: ReindexProgress) => void): Promise<ReindexResult> }`, `interface ReindexJobs { start(): { job_id: string }; status(): ReindexJobStatus; isRunning(): boolean; wait(): Promise<void> }`, `createReindexJobs(runner: ReindexRunner, now?: () => Date, newId?: () => string): ReindexJobs`
  - Routes: `POST /api/knowledge/reindex` → `202 { job_id, status: "running" }` (409 if running or benchmark active); `GET /api/knowledge/reindex/status` → `ReindexJobStatus`

- [ ] **Step 1: Write the failing job-store tests**

Create `__tests__/reindex-jobs.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { createReindexJobs } from "../src/services/reindex-jobs.js";
import type { ReindexProgress, ReindexResult } from "../src/services/reindex.js";

const result: ReindexResult = {
  stack: "ollama",
  knowledgeFiles: 40,
  rawDocuments: 7023,
  memoryChunks: 7626,
  chromaChunks: 7289,
  skippedRawDocuments: 0,
  seconds: 947.1,
};

interface Deferred {
  promise: Promise<ReindexResult>;
  resolve: (value: ReindexResult) => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (value: ReindexResult) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<ReindexResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixedClock(): () => Date {
  const times = ["2026-09-17T10:00:00.000Z", "2026-09-17T10:15:47.000Z"];
  return () => new Date(times.shift() ?? "2026-09-17T23:59:59.000Z");
}

describe("createReindexJobs", () => {
  it("starts idle", () => {
    const jobs = createReindexJobs(() => deferred().promise);
    expect(jobs.status()).toEqual({ job_id: null, status: "idle" });
    expect(jobs.isRunning()).toBe(false);
  });

  it("tracks a running job, its progress and its result", async () => {
    const run = deferred();
    let report: (progress: ReindexProgress) => void = () => {};
    const jobs = createReindexJobs(
      (onProgress) => {
        report = onProgress;
        return run.promise;
      },
      fixedClock(),
      () => "job-1"
    );

    expect(jobs.start()).toEqual({ job_id: "job-1" });
    expect(jobs.isRunning()).toBe(true);
    report({ rawDocumentsDone: 64, rawDocumentsTotal: 7023 });
    expect(jobs.status()).toEqual({
      job_id: "job-1",
      status: "running",
      started_at: "2026-09-17T10:00:00.000Z",
      progress: { raw_documents_done: 64, raw_documents_total: 7023 },
    });

    run.resolve(result);
    await jobs.wait();

    expect(jobs.status()).toMatchObject({
      job_id: "job-1",
      status: "succeeded",
      finished_at: "2026-09-17T10:15:47.000Z",
      result,
    });
    expect(jobs.isRunning()).toBe(false);
  });

  it("records a failure", async () => {
    const run = deferred();
    const jobs = createReindexJobs(() => run.promise, fixedClock(), () => "job-2");

    jobs.start();
    run.reject(new Error("OLLAMA stack not reachable"));
    await jobs.wait();

    expect(jobs.status()).toMatchObject({ job_id: "job-2", status: "failed", error: "OLLAMA stack not reachable" });
  });

  it("refuses to start a second job while one is running", () => {
    const jobs = createReindexJobs(() => deferred().promise);
    jobs.start();
    expect(() => jobs.start()).toThrow("A reindex is already running");
  });
});
```

Run: `npm run test -- __tests__/reindex-jobs.test.ts`
Expected: FAIL with `Cannot find module '../src/services/reindex-jobs.js'` (and `ReindexProgress` missing from `reindex.js`).

- [ ] **Step 2: Add the progress callback to `reindexActiveStack`**

In `src/services/reindex.ts`, add directly above `export interface IndexState {`:

```ts
export interface ReindexProgress {
  rawDocumentsDone: number;
  rawDocumentsTotal: number;
}

```

Replace the signature:

```ts
export async function reindexActiveStack(
  log: (message: string) => void = console.log,
  deps?: ReindexDeps
): Promise<ReindexResult> {
```

with:

```ts
export async function reindexActiveStack(
  log: (message: string) => void = console.log,
  deps?: ReindexDeps,
  onProgress?: (progress: ReindexProgress) => void
): Promise<ReindexResult> {
```

Replace:

```ts
    const docs = await deps.listRawDocuments();
    let processed = 0;
```

with:

```ts
    const docs = await deps.listRawDocuments();
    onProgress?.({ rawDocumentsDone: 0, rawDocumentsTotal: docs.length });
    let processed = 0;
```

In the raw-document loop, the `try { … } catch (err) { … }` block ends with:

```ts
        log(`[Reindex] skipped raw documents ${range}: ${errorMessage(err)}`);
      }
    }
```

Replace those three lines with:

```ts
        log(`[Reindex] skipped raw documents ${range}: ${errorMessage(err)}`);
      }
      onProgress?.({
        rawDocumentsDone: Math.min((i + 1) * RAW_DOCUMENT_BATCH_SIZE, docs.length),
        rawDocumentsTotal: docs.length,
      });
    }
```

- [ ] **Step 3: Add a progress test to the reindex tests**

In `__tests__/reindex.test.ts`, the default `fakeDeps()` returns 130 raw documents (`rawDocs(130)`), and batches hold 64 documents. Add `ReindexProgress` to the existing type import from `../src/services/reindex.js` (it currently reads `import type { IndexState, ReindexDeps } from "../src/services/reindex.js";`; change it to `import type { IndexState, ReindexDeps, ReindexProgress } from "../src/services/reindex.js";`), then add this test inside `describe("reindexActiveStack", …)`, directly above the test named `"refuses to fall back to live services when deps are omitted in a test run"`:

```ts
  it("reports raw-document progress after each batch", async () => {
    const { deps } = fakeDeps();
    const progress: ReindexProgress[] = [];

    await reindexActiveStack(quiet, deps, (p) => progress.push(p));

    expect(progress).toEqual([
      { rawDocumentsDone: 0, rawDocumentsTotal: 130 },
      { rawDocumentsDone: 64, rawDocumentsTotal: 130 },
      { rawDocumentsDone: 128, rawDocumentsTotal: 130 },
      { rawDocumentsDone: 130, rawDocumentsTotal: 130 },
    ]);
  });
```

Run: `npm run test -- __tests__/reindex.test.ts`
Expected: this new test FAILS until Step 2's changes are in place (if Step 2 is already applied, it passes; confirm RED by temporarily changing `64` to `65` in the expectation, run, see it fail, restore). All tests keep injecting deps.

- [ ] **Step 4: Implement the job store**

Create `src/services/reindex-jobs.ts`:

```ts
// In-memory tracking of background reindex jobs started through the API

import { randomUUID } from "node:crypto";
import type { ReindexProgress, ReindexResult } from "./reindex.js";

export interface ReindexJobStatus {
  job_id: string | null;
  status: "idle" | "running" | "succeeded" | "failed";
  started_at?: string;
  finished_at?: string;
  progress?: { raw_documents_done: number; raw_documents_total: number };
  result?: ReindexResult;
  error?: string;
}

export interface ReindexRunner {
  (onProgress: (progress: ReindexProgress) => void): Promise<ReindexResult>;
}

export interface ReindexJobs {
  start(): { job_id: string };
  status(): ReindexJobStatus;
  isRunning(): boolean;
  wait(): Promise<void>;
}

// Only the most recent job is kept; the index completeness markers remain the source of truth after a restart
export function createReindexJobs(
  runner: ReindexRunner,
  now: () => Date = () => new Date(),
  newId: () => string = randomUUID
): ReindexJobs {
  let current: ReindexJobStatus = { job_id: null, status: "idle" };
  let pending: Promise<void> = Promise.resolve();

  return {
    start() {
      if (current.status === "running") throw new Error("A reindex is already running");

      const jobId = newId();
      current = { job_id: jobId, status: "running", started_at: now().toISOString() };

      pending = runner((progress) => {
        if (current.job_id !== jobId) return;
        current = {
          ...current,
          progress: { raw_documents_done: progress.rawDocumentsDone, raw_documents_total: progress.rawDocumentsTotal },
        };
      })
        .then((result) => {
          current = { ...current, status: "succeeded", finished_at: now().toISOString(), result };
        })
        .catch((err: unknown) => {
          current = {
            ...current,
            status: "failed",
            finished_at: now().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          };
        });

      return { job_id: jobId };
    },
    status: () => current,
    isRunning: () => current.status === "running",
    wait: () => pending,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -- __tests__/reindex-jobs.test.ts __tests__/reindex.test.ts`
Expected: PASS (4 job-store tests plus the reindex tests, including the new progress test).

- [ ] **Step 6: Make the routes asynchronous**

In `src/api/knowledge.ts`, add below `import { reindexActiveStack } from "../services/reindex.js";`:

```ts
import { createReindexJobs } from "../services/reindex-jobs.js";
```

Replace the whole `router.post("/reindex", …)` handler (from `// POST /api/knowledge/reindex - Rebuild the active stack's indexes from knowledge/ and raw documents` to its closing `});`) with:

```ts
// Background reindex jobs (a rebuild takes 12-16 minutes, longer than any HTTP client should wait)
const reindexJobs = createReindexJobs((onProgress) =>
  trackJob("reindex", () => reindexActiveStack(console.log, undefined, onProgress))
);

// POST /api/knowledge/reindex - Start rebuilding the active stack's indexes in the background
router.post("/reindex", (_req: Request, res: Response): void => {
  if (reindexJobs.isRunning() || getRunningJobs().includes("reindex")) {
    res.status(409).json({ error: "A reindex is already running" });
    return;
  }
  if (isBenchmarkActive()) {
    res.status(409).json({ error: "Benchmark in progress — reindex after it finishes" });
    return;
  }

  const { job_id } = reindexJobs.start();
  res.status(202).json({ job_id, status: "running" });
});

// GET /api/knowledge/reindex/status - State and progress of the most recent reindex job
router.get("/reindex/status", (_req: Request, res: Response): void => {
  res.json(reindexJobs.status());
});
```

Run: `grep -n "Re-indexing complete\|documents_processed" src/api/knowledge.ts || echo "old synchronous response removed"`
Expected: `old synchronous response removed`.

- [ ] **Step 7: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; 120 + 4 job-store + 1 progress = 125 tests pass.

```bash
git add src/services/reindex.ts src/services/reindex-jobs.ts src/api/knowledge.ts __tests__/reindex-jobs.test.ts __tests__/reindex.test.ts
git commit -m "feat: run API reindexes as background jobs with progress

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Token tooling, n8n headers and documentation

**Files:**
- Modify: `scripts/switch-stack.sh`, `scripts/start-services.sh`, `n8n/knowledge_gap_workflow.json`, `n8n/knowledge_gap_workflow_v2.json`, `n8n/knowledge_qa_workflow.json`, `n8n/README.md`, `README.md`

**Interfaces:**
- Consumes: `PHARMALLM_API_TOKEN` handling (Task 5), `/v1` (Task 6), MCP service (Tasks 1–4), async reindex (Task 7).
- Produces: `scripts/switch-stack.sh token`; token file `data/run/api-token`; app started by `switch-stack.sh` and `start-services.sh` receives `PHARMALLM_API_TOKEN`.

- [ ] **Step 1: Add the token command to `scripts/switch-stack.sh`**

In the header, replace:

```bash
#   scripts/switch-stack.sh status                   show the active stack, ports and index counts
```

with:

```bash
#   scripts/switch-stack.sh status                   show the active stack, ports and index counts
#   scripts/switch-stack.sh token                    create the API token for agents and other machines
```

Replace:

```bash
RUN_DIR="$PROJECT_DIR/data/run"
```

with:

```bash
RUN_DIR="$PROJECT_DIR/data/run"
TOKEN_FILE="$RUN_DIR/api-token"
```

Add these functions directly above the line `start_app() {`:

```bash
# API token for agents and other machines (readable only by you)
ensure_token() {
  if [ -s "$TOKEN_FILE" ]; then
    log "API token already exists at $TOKEN_FILE"
  else
    (umask 077 && openssl rand -hex 32 >"$TOKEN_FILE")
    log "Created API token at $TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  log "Restart the app to enforce it: scripts/switch-stack.sh $(active_stack)"
  log "Use it in a shell with: export PHARMALLM_API_TOKEN=\"\$(cat $TOKEN_FILE)\""
}

api_token() {
  if [ -s "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
  fi
}

```

In `start_app`, replace:

```bash
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
```

with:

```bash
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" PHARMALLM_API_TOKEN="$(api_token)" \
    nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
```

In the command dispatch, replace:

```bash
  status) status ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
```

with:

```bash
  status) status ;;
  token) ensure_token ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
```

- [ ] **Step 2: Export the token in `scripts/start-services.sh`**

Replace:

```bash
export LLM_PROVIDER="$STACK"
```

with:

```bash
export LLM_PROVIDER="$STACK"
# API token for agents and other machines, created by scripts/switch-stack.sh token
if [ -s "$PROJECT_DIR/data/run/api-token" ]; then
  export PHARMALLM_API_TOKEN="$(cat "$PROJECT_DIR/data/run/api-token")"
fi
```

- [ ] **Step 3: Check the scripts**

Run: `bash -n scripts/switch-stack.sh && bash -n scripts/start-services.sh && npm run test -- __tests__/switch-stack-config.test.ts`
Expected: no syntax errors; 4 tests pass.

Run: `scripts/switch-stack.sh; echo "exit=$?"`
Expected: 7 usage lines including the `token` line, then `exit=1`.

Do not run `scripts/switch-stack.sh token` here; Task 9 does it with the user's agreement.

- [ ] **Step 4: Add the Authorization header to protected n8n calls**

```bash
python3 - <<'EOF'
import json
PROTECTED = ("/api/llm/complete", "/api/knowledge/gaps/check-resolution", "/api/dashboard/kb-health")
HEADER = {"parameters": [{"name": "Authorization", "value": "=Bearer {{ $env.PHARMALLM_API_TOKEN }}"}]}
for path in ["n8n/knowledge_gap_workflow.json", "n8n/knowledge_gap_workflow_v2.json", "n8n/knowledge_qa_workflow.json"]:
    workflow = json.load(open(path, encoding="utf-8"))
    count = 0
    for node in workflow["nodes"]:
        params = node.get("parameters", {})
        if str(params.get("url", "")).endswith(PROTECTED):
            params["sendHeaders"] = True
            params["specifyHeaders"] = "keypair"
            params["headerParameters"] = HEADER
            count += 1
    with open(path, "w", encoding="utf-8") as f:
        json.dump(workflow, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(path, count)
EOF
```

Expected: `n8n/knowledge_gap_workflow.json 2`, `n8n/knowledge_gap_workflow_v2.json 3`, `n8n/knowledge_qa_workflow.json 2`.

Run: `git diff --stat n8n/`
Expected: only the three JSON files changed. If the diff is much larger than the added header blocks (reformatting of the whole file), check whether the original files used 2-space indentation; if they used another style, re-run the script with that indentation so the diff stays focused.

- [ ] **Step 5: Document the token for n8n**

Append to `n8n/README.md`:

```markdown

**Token API PharmaLLM :**
- Les appels protégés (`/api/llm/complete`, `/api/knowledge/gaps/check-resolution`, `/api/dashboard/kb-health`) envoient `Authorization: Bearer {{ $env.PHARMALLM_API_TOKEN }}`
- Sans token configuré dans PharmaLLM, ces routes n'acceptent que les requêtes locales : n8n doit tourner sur la même machine
- Avec un token (`scripts/switch-stack.sh token`), démarrer n8n avec `PHARMALLM_API_TOKEN="$(cat data/run/api-token)"` et `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` pour que l'expression `$env` fonctionne
- Une réponse 401 signifie un token absent ou différent de celui de PharmaLLM
```

- [ ] **Step 6: Document agents in `README.md`**

Insert directly above `## API Reference`:

````markdown
## Agents and MCP

PharmaLLM can serve AI agents such as [Hermes Agent](https://hermes-agent.nousresearch.com/) in two ways:

| | Endpoint | Purpose |
|---|---|---|
| 🧰 **MCP tools** | `pharmallm-mcp` at `http://<host>:3200/mcp` | 16 tools: search, full RAG answers, add knowledge, graph, gaps, health, news agent, background reindex, feedback |
| 🧠 **Model gateway** | `http://<host>:3000/v1` | OpenAI-compatible chat completions on the active stack (tools and streaming supported) |

```bash
scripts/switch-stack.sh token             # create data/run/api-token, then restart the app
npm --prefix mcp install
PHARMALLM_API_TOKEN="$(cat data/run/api-token)" npm --prefix mcp start
```

- **Security:** without a token, the gateway and operations routes only accept requests from the same machine. With a token, every protected route requires `Authorization: Bearer <token>`. Browser UI routes stay open.
- **Two machines:** run the agent on one Mac and PharmaLLM plus the model on another by pointing the agent at the model Mac's LAN or Tailscale address. Start the MCP service with `MCP_HOST` and `MCP_TOKEN` there (see [`mcp/README.md`](mcp/README.md)).
- **One stack at a time still holds:** gateway requests go to the active stack and are refused (503) during benchmarks.

---

````

In the Configuration environment-variable table, add below the `| `APP_URL` | …` row:

```markdown
| `PHARMALLM_API_TOKEN` | *(none)* | Token for `/v1` and operations routes; without it they accept local requests only |
```

- [ ] **Step 7: Commit**

```bash
git add scripts/switch-stack.sh scripts/start-services.sh n8n/knowledge_gap_workflow.json n8n/knowledge_gap_workflow_v2.json n8n/knowledge_qa_workflow.json n8n/README.md README.md
git commit -m "feat: add API token tooling, n8n auth headers and agent docs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Live verification

Runs the new pieces against the real app. Ask the user before Step 4 (it creates a token and restarts the app; with a token set, local tools like n8n need it).

**Files:**
- Modify: `docs/superpowers/plans/2026-09-17-pharmallm-mcp-server-verification.md` (append results)

- [ ] **Step 1: Restart the app with the new code (no token yet)**

```bash
scripts/switch-stack.sh ollama
curl -s localhost:3000/api/health | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["stack"], d["status"])'
```

Expected: `ollama healthy` (or `degraded`).

- [ ] **Step 2: Check the gateway locally**

```bash
curl -s localhost:3000/v1/models
curl -s localhost:3000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "anything", "max_tokens": 120,
  "messages": [{"role": "user", "content": "What is the weather in Basel? Use the tool."}],
  "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); c=d["choices"][0]; print(d.get("model"), c["finish_reason"], json.dumps(c["message"].get("tool_calls"))[:160])'
```

Expected: `/v1/models` lists `qwen3.8-pharma`; the completion shows `finish_reason` `tool_calls` with a `get_weather` call.

- [ ] **Step 3: Call real tools through the MCP service**

```bash
cd mcp
node --import tsx src/server.ts > ../data/logs/mcp-live.log 2>&1 &
MCP_PID=$!
sleep 3
cat > ../data/run/mcp-live-check.mts <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "live-check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3200/mcp")));
const { tools } = await client.listTools();
console.log("tools:", tools.length);
for (const [name, args] of [["system_health", {}], ["search_knowledge", { query: "Dell PowerProtect Cyber Recovery", top_k: 2 }], ["graph_stats", {}], ["reindex_status", {}]] as const) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  console.log(name, result.isError ? "ERROR" : "ok", text.slice(0, 160).replace(/\s+/g, " "));
}
await client.close();
EOF
node --import tsx ../data/run/mcp-live-check.mts
kill "$MCP_PID"; rm ../data/run/mcp-live-check.mts; cd ..
```

Expected: `tools: 16`; `system_health ok` (stack ollama), `search_knowledge ok` with Dell chunks, `graph_stats ok`, `reindex_status ok` with `"status": "idle"`.

- [ ] **Step 4: Ask the user whether to enable the token now.** If yes:

```bash
scripts/switch-stack.sh token
scripts/switch-stack.sh ollama
TOKEN="$(cat data/run/api-token)"
TS_IP="$(/usr/local/bin/tailscale ip -4)"
curl -s -o /dev/null -w "no token, localhost: %{http_code}\n" localhost:3000/v1/models
curl -s -o /dev/null -w "token, localhost: %{http_code}\n" -H "Authorization: Bearer $TOKEN" localhost:3000/v1/models
curl -s -o /dev/null -w "no token, tailscale: %{http_code}\n" "http://$TS_IP:3000/api/bench/status"
curl -s -o /dev/null -w "token, tailscale: %{http_code}\n" -H "Authorization: Bearer $TOKEN" "http://$TS_IP:3000/api/bench/status"
curl -s -o /dev/null -w "browser route, tailscale: %{http_code}\n" "http://$TS_IP:3000/api/health"
```

Expected: `401`, `200`, `401`, `200`, `200`.

If the user declines, verify loopback-only mode instead:

```bash
TS_IP="$(/usr/local/bin/tailscale ip -4)"
curl -s -o /dev/null -w "no token, tailscale: %{http_code}\n" "http://$TS_IP:3000/api/bench/status"
curl -s -o /dev/null -w "no token, localhost: %{http_code}\n" localhost:3000/api/bench/status
```

Expected: `401`, `200`.

- [ ] **Step 5: Final checks and record**

Run: `npm run typecheck && npm run typecheck:tests && npm run test && npm --prefix mcp run typecheck && npm --prefix mcp test`
Expected: all exit 0; 125 root tests and 41 MCP tests pass.

Append a "Live verification" section to `docs/superpowers/plans/2026-09-17-pharmallm-mcp-server-verification.md` with each step's output, then:

```bash
git add docs/superpowers/plans/2026-09-17-pharmallm-mcp-server-verification.md
git commit -m "docs: record MCP service and gateway live verification

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

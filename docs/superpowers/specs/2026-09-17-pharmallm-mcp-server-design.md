# PharmaLLM MCP Server and Agent Gateway

## Overview

Let AI agents — first Nous Research's Hermes Agent — use PharmaLLM as a tool and as a model provider. Two deliverables:

1. **`pharmallm-mcp`**: a standalone MCP service that exposes PharmaLLM's knowledge base, graph, gap loop, operations and feedback as MCP tools, by calling PharmaLLM's REST API.
2. **PharmaLLM changes**: an OpenAI-compatible model gateway (`/v1`) that proxies to the active LLM stack, token authentication for everything except the browser UI, and an asynchronous reindex.

The design must keep working when Hermes runs on one Mac and PharmaLLM plus the model run on another Mac on the same LAN. Today everything runs on the Mac mini.

This spec covers sub-project 1. Installing and configuring Hermes Agent is sub-project 2, with its own spec.

## Decisions

| Topic | Decision |
|-------|----------|
| Tool scope | Full operations: knowledge, graph, gaps, health/metrics, news agent, reindex, feedback |
| Not exposed | Stack switching, benchmark control, graph rebuild, audio transcription |
| MCP deployment | Separate package and process (`mcp/`), MCP over Streamable HTTP, stateless |
| Model access for agents | OpenAI-compatible gateway inside PharmaLLM (`/v1`), always the active stack |
| LAN split | Supported by configuration only (URLs); no Ollama/MLX port is exposed on the network |
| Auth | `PHARMALLM_API_TOKEN` protects `/v1/*` and every `/api/*` route except browser-UI routes; `MCP_TOKEN` protects the MCP service |
| No token configured | Protected PharmaLLM routes accept loopback requests only |
| Reindex via tools | Asynchronous job with status polling |

## Architecture

```
┌──────────── Hermes Mac (today: same machine) ─────────────┐
│ Hermes Agent ── MCP over HTTP + MCP_TOKEN ──▶ pharmallm-mcp :3200 │──┐
│      │                                                           │  │ REST + PHARMALLM_API_TOKEN
│      └──── OpenAI API + PHARMALLM_API_TOKEN ─────────────────────────┼──────────┐
└───────────────────────────────────────────────────────────────────┘  │          │
┌──────────── Model Mac ─────────────────────────────────────────────▼──────────▼───┐
│ PharmaLLM :3000   /api/* (UI routes open, others need token)   /v1/* (token)        │
│                                        └── active stack: Ollama :11434 or MLX :8080 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- `pharmallm-mcp` contains no RAG logic. Each tool maps to one or two REST calls. It can run on either Mac (`PHARMALLM_URL`).
- The gateway stays inside PharmaLLM because it must follow app state: active stack, benchmark lease, running jobs, and the one-stack-at-a-time rule.

## Component 1: `pharmallm-mcp` (`mcp/`)

### Package

- `mcp/package.json` (`"name": "pharmallm-mcp"`, `"type": "module"`), own `tsconfig.json`, own Jest config, TypeScript strict, ESM.
- Dependencies: `@modelcontextprotocol/sdk` (1.30.x), `zod` (tool input schemas), `express` (HTTP host for the Streamable HTTP transport).
- Entry point `mcp/src/server.ts`; start with `npm --prefix mcp run start` (tsx) or `npm --prefix mcp run dev`.

### Configuration (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_PORT` | `3200` | Listen port |
| `MCP_HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` or a LAN/Tailscale IP to serve another Mac |
| `MCP_TOKEN` | *(required when `MCP_HOST` is not loopback)* | Bearer token agents must send |
| `PHARMALLM_URL` | `http://localhost:3000` | PharmaLLM base URL |
| `PHARMALLM_API_TOKEN` | *(none)* | Sent to PharmaLLM as `Authorization: Bearer …` |

If `MCP_HOST` is not a loopback address and `MCP_TOKEN` is unset, the service refuses to start with a clear error.

### Transport

- Streamable HTTP at `POST /mcp` using the SDK's stateless mode: a new transport and server per request, no session IDs.
- `GET /healthz` returns `{ ok: true, pharmallm: <reachable?> }` (no auth, no secrets).
- Every `/mcp` request requires `Authorization: Bearer <MCP_TOKEN>` when a token is configured (constant-time comparison); otherwise loopback-only.

### Module layout

| File | Responsibility |
|------|----------------|
| `mcp/src/config.ts` | Read and validate environment |
| `mcp/src/pharmallm-client.ts` | Typed REST client: base URL, token header, per-call timeout, error normalization, SSE collection for `/api/chat` |
| `mcp/src/tools/*.ts` | One file per tool group (knowledge, graph, gaps, operations, feedback), each exporting tool definitions |
| `mcp/src/mcp-server.ts` | Build an `McpServer` and register all tools |
| `mcp/src/http.ts` | Express app: auth middleware, `/mcp`, `/healthz` |
| `mcp/src/server.ts` | Entry point |

### Tools

Tool results are JSON text content. PharmaLLM errors become tool errors (`isError: true`) whose text is PharmaLLM's error message and HTTP status.

| Tool | Input | PharmaLLM call(s) | Output |
|------|-------|-------------------|--------|
| `search_knowledge` | `query: string`, `top_k?: 1–20 (default 5)` | `POST /api/knowledge/search` `{ query, topK }` | chunks with `source`, `content` |
| `ask_pharmallm` | `question: string`, `web_search?: boolean (default false)` | `POST /api/chat` `{ message, webSearch }`, SSE collected until `done` or `error` | `answer`, `sources` (from reasoning events), `stack`, `response_id`, `timings` |
| `add_knowledge` | exactly one of `text` + `source`, or `url` | text: `POST /api/knowledge/ingest-text` `{ text, source }`; url: `POST /api/knowledge/add` `{ url }` | added chunk count, source |
| `knowledge_status` | — | `GET /api/knowledge/stats`, `GET /api/knowledge/status` | chunk counts, sources count, ChromaDB status |
| `graph_search` | `entity: string` | `POST /api/graph/search` `{ name }` | entity and neighbours |
| `graph_stats` | — | `GET /api/graph/stats` | counts by label and relationship type |
| `list_knowledge_gaps` | `status?: "detected" \| "resolved" \| "unresolved"` | `GET /api/knowledge/gaps`, `GET /api/knowledge/gaps/stats` | recent gaps (filtered client-side) and stats |
| `resolve_knowledge_gap` | `gap_id: number`, `original_query: string`, `search_topic?: string` | `POST /api/knowledge/gaps/check-resolution` | `resolved`, `new_response`, `confidence_reason` |
| `system_health` | — | `GET /api/health` | status, stack, checks, `benchmark_active` |
| `dashboard_metrics` | — | `GET /api/dashboard/metrics` | metrics object |
| `run_news_agent` | — | `POST /api/agent/run` | new articles, topics |
| `news_agent_status` | — | `GET /api/agent/status` | running, last run, schedule |
| `start_reindex` | — | `POST /api/knowledge/reindex` | `job_id`, status `running` |
| `reindex_status` | — | `GET /api/knowledge/reindex/status` | job state, progress, result or error |
| `record_feedback` | `rating: 1–5`, `response_id?: string`, `comment?: string` | `POST /api/feedback` `{ rating, response_id, comment }` | stored feedback id |
| `feedback_report` | `kind: "stats" \| "low_rated" \| "weekly_digest"` | `GET /api/feedback/stats` \| `/low-rated` \| `/weekly-digest` | report object |

Timeouts: `ask_pharmallm` 5 minutes; `run_news_agent` 15 minutes (the route runs the scrub synchronously); all other tools 30 seconds. Tool descriptions state the expected duration so agents can plan (e.g. "takes about 1–2 minutes").

## Component 2: PharmaLLM model gateway (`/v1`)

New router `src/api/v1.ts`, mounted at `/v1`.

- `GET /v1/models` → `{ object: "list", data: [{ id: <active stack chatModel>, object: "model", owned_by: "pharmallm" }] }` after probing stack reachability; 503 if the stack is down.
- `POST /v1/chat/completions`:
  - Rejects with 503 (`{ error: { message, type: "service_unavailable" } }`) while benchmark mode is active.
  - Builds the upstream body: the client's `messages`, `tools`, `tool_choice`, `stream`, `stream_options`, `temperature`, `max_tokens` (capped at 4096; default 4096 when absent); `model` replaced with the stack chat model; the stack's `chatExtraBody` merged in.
  - Forwards to `<stack.chatBaseUrl>/v1/chat/completions` and pipes the upstream status, headers (`content-type`) and body to the client unchanged (streaming passes through byte for byte).
  - Upstream connection failure → 503 with the `StackUnavailableError` message; no fallback.
  - Wrapped in `trackJob("agent-completion", …)` so benchmarks wait for it.
- Lives in a service module `src/services/model-gateway.ts` (pure body-building + forwarding with injectable fetch) and a thin router.

## Component 3: API token authentication

New middleware `src/api/auth.ts`, mounted before all routers.

- Token source: `PHARMALLM_API_TOKEN` environment variable.
- Protected: all `/v1/*`, and all `/api/*` except the browser allowlist below. Static files (`/`, `/dashboard`) are never protected.
- Browser allowlist (method + path): `POST /api/chat`, `GET /api/chat/models`, `POST /api/chat/transcribe`, `POST /api/knowledge/search`, `GET /api/knowledge/stats`, `POST /api/knowledge/upload`, `POST /api/knowledge/ingest-text`, `POST /api/agent/run`, `GET /api/agent/status`, `GET /api/dashboard/metrics`, `GET /api/dashboard/chromadb-misses`, `GET /api/graph/stats`, `GET /api/health`.
- Token configured: protected requests need `Authorization: Bearer <token>` (constant-time compare); otherwise 401 `{ error: "Unauthorized" }`.
- No token configured: protected requests are allowed only from loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`); otherwise 401 with a hint to configure `PHARMALLM_API_TOKEN`.
- `scripts/switch-stack.sh token` creates `data/run/api-token` (32 random bytes, hex, mode 600) if missing and prints how to use it; `switch-stack.sh` `start_app` and `scripts/start-services.sh` export `PHARMALLM_API_TOKEN` from that file when present. `.env` files are not used.
- n8n: HTTP Request nodes calling protected routes (`/api/llm/complete`, `/api/knowledge/gaps/check-resolution`, `/api/dashboard/kb-health`) get `Authorization: Bearer {{ $env.PHARMALLM_API_TOKEN }}`; `n8n/README.md` documents setting the variable.

## Component 4: Asynchronous reindex

- `POST /api/knowledge/reindex`: keeps its 409 guards (reindex running, benchmark active); starts `reindexActiveStack` in the background via `trackJob("reindex", …)` and returns `202 { job_id, status: "running" }`.
- `GET /api/knowledge/reindex/status`: `{ job_id, status: "idle" | "running" | "succeeded" | "failed", started_at, finished_at?, progress?: { raw_documents_done, raw_documents_total }, result?: ReindexResult, error?: string }` for the most recent job.
- Progress comes from a new optional `onProgress({ rawDocumentsDone, rawDocumentsTotal })` callback on `reindexActiveStack` (structured, so log lines are never parsed).
- Job state is in memory (`src/services/reindex-jobs.ts`); a server restart forgets it (the index completeness markers remain the source of truth).
- The n8n workflows don't call reindex; the CLI (`scripts/reindex-stack.ts`) is unchanged.

## Error Handling

| Situation | Behavior |
|-----------|----------|
| PharmaLLM unreachable from MCP service | Tool error "PharmaLLM not reachable at <url>"; service stays up |
| PharmaLLM 401 | Tool error "PharmaLLM rejected the API token — check PHARMALLM_API_TOKEN" |
| Stack down / index refused / 409 / 503 | Tool error with PharmaLLM's message and status |
| MCP tool timeout | Tool error "PharmaLLM did not answer within <n> s" |
| Gateway during benchmark | 503 OpenAI-style error |
| Gateway upstream down | 503 OpenAI-style error, no fallback |
| Invalid tool input | Rejected by zod schema before any REST call |
| Logging | MCP service logs tool name, duration, outcome; never tokens or full request bodies |

## Testing

All tests use fakes; **no test may reach real ChromaDB, model servers, index files or the running app.**

- `mcp/__tests__/`:
  - `pharmallm-client.test.ts`: token header, timeouts, error normalization, SSE collection (tokens, reasoning sources, `done`, `error`) against a fake PharmaLLM HTTP server.
  - One test file per tool group: input validation and REST mapping against the fake server.
  - `http.test.ts`: `/mcp` auth (missing/wrong/valid token, loopback-only without token), refusal to start on non-loopback host without `MCP_TOKEN`, `/healthz`.
  - `e2e.test.ts`: SDK `Client` + `StreamableHTTPClientTransport` lists tools and calls `search_knowledge` through the real HTTP stack against the fake PharmaLLM.
- PharmaLLM `__tests__/`:
  - `auth.test.ts`: allowlist open, protected route 401 without token, token accepted, loopback-only when no token.
  - `model-gateway.test.ts`: model forced, extra body merged, tools passed through, `max_tokens` cap, streaming passthrough, benchmark 503, upstream-down 503 (fake OpenAI server).
  - `reindex-jobs.test.ts`: 202 start, 409 while running, status transitions and progress, failure recorded (injected reindex function).

## Verification Items (start of implementation)

1. MLX tool calling through `mlx_lm.server` 0.31.3 with Qwen3.8 (`qwen3_coder` parser inferred from the chat template) — live request with a `tools` array on the MLX stack.
2. Ollama tool calling through `/v1/chat/completions` — verified 2026-09-17 (`get_weather` tool call returned).
3. `@modelcontextprotocol/sdk` 1.30 stateless Streamable HTTP server pattern and client transport API names.
4. n8n `$env` access in HTTP Request node headers (`N8N_BLOCK_ENV_ACCESS_IN_NODE` default) on the user's n8n version.
5. Express `req.socket.remoteAddress` values for loopback over IPv4/IPv6 on macOS.

## New Files

- `mcp/package.json`, `mcp/tsconfig.json`, `mcp/jest.config.js`, `mcp/src/*.ts`, `mcp/src/tools/*.ts`, `mcp/__tests__/*.test.ts`, `mcp/README.md`
- `src/api/v1.ts`, `src/services/model-gateway.ts`
- `src/api/auth.ts`
- `src/services/reindex-jobs.ts`
- `__tests__/auth.test.ts`, `__tests__/model-gateway.test.ts`, `__tests__/reindex-jobs.test.ts`

## Modified Files

| File | Change |
|------|--------|
| `src/server.ts` | Mount auth middleware, `/v1` router |
| `src/api/knowledge.ts` | Async reindex route + status route |
| `src/services/reindex.ts` | Optional `onProgress` callback |
| `scripts/switch-stack.sh`, `scripts/start-services.sh` | `token` command; export `PHARMALLM_API_TOKEN` |
| `n8n/*.json`, `n8n/README.md` | Authorization header on protected calls |
| `README.md` | Agents section: MCP service, gateway, tokens, LAN split |
| `.gitignore` | `mcp/node_modules/` |

## Out of Scope

- Installing and configuring Hermes Agent (sub-project 2)
- Exposing stack switching, benchmark control, graph rebuild or transcription as tools
- HTTPS for the MCP service (Tailscale already encrypts; LAN use is plain HTTP with tokens)
- Persisting reindex job history across restarts
- Per-agent tokens or scopes

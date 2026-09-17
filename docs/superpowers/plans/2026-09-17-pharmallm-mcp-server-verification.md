# PharmaLLM MCP Server & Gateway — Task 0 Verification Spike

Date: 2026-09-17
Branch: `feature/pharmallm-mcp-gateway`
Machine: Mac mini, macOS 26.4, arm64; Node v22.22.0

Summary: all expectations from the Task 0 brief were met. MLX tool calling
works live on `mlx_lm.server`, both non-streaming (`finish_reason:
tool_calls` with a well-formed `tool_calls` array) and streaming (SSE deltas
carrying `tool_calls`, count 2 ≥ 1). Both stack switches completed in about a
minute with no rebuild (existing indexes reused). Node's loopback address
probe only produced formats already in the expected set
(`::ffff:127.0.0.1`, `::1`). The app finished healthy on the `ollama` stack.

## Step 1: Tell the user

Handled by the controller before this spike started: the user approved this
plan's execution and was told the app switches to MLX briefly and back.

## Step 2: Switch to MLX and test tool calling

```
$ scripts/switch-stack.sh mlx   # run in background, logged to data/logs/task0-switch-mlx.log
[switch-stack] ChromaDB already running on port 8100
[switch-stack] Switching: ollama -> mlx
[switch-stack] Warming up mlx...
[switch-stack] Indexes for mlx are ready
[switch-stack] PharmaLLM is up on the mlx stack
[switch-stack] Active stack: mlx
```

**Pass** — indexes reused, no rebuild, finished in well under a minute of
active wait (background poll interval was coarser).

```
$ curl -s localhost:3000/api/health
{"status":"healthy","stack":"mlx", ...}
```

**Pass** — app healthy on `mlx` before the tool-call tests.

Non-streaming tool call (`max_tokens: 120`, thinking disabled, first request
so the model was loading — run with a 300s curl timeout in the background):

```
$ curl -s -m 300 http://localhost:8080/v1/chat/completions ... \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); c=d["choices"][0]; print(c["finish_reason"], json.dumps(c["message"].get("tool_calls")))'
tool_calls [{"function": {"name": "get_weather", "arguments": "{\"city\": \"Basel\"}"}, "type": "function", "id": "c2bccd6f-16a9-40b1-b298-0945778d5c18"}]
```

Full response body:

```json
{"id": "chatcmpl-41d3dfd8-1c65-464b-8d1e-6573e7cfc770", "system_fingerprint": "0.31.3-0.32.2-macOS-26.4-arm64-arm-64bit-Mach-O-applegpu_g16s", "object": "chat.completion", "model": "mlx-community/Qwen3.8-27B-4bit", "created": 1789625481, "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "tool_calls": [{"function": {"name": "get_weather", "arguments": "{\"city\": \"Basel\"}"}, "type": "function", "id": "c2bccd6f-16a9-40b1-b298-0945778d5c18"}]}}], "usage": {"prompt_tokens": 280, "completion_tokens": 27, "total_tokens": 307, "prompt_tokens_details": {"cached_tokens": 0}}}
```

**Pass** — matches the expected shape exactly: `finish_reason: "tool_calls"`,
`function.name: "get_weather"`, `arguments: "{\"city\": \"Basel\"}"`.

Streaming tool call (same request, `"stream": true`):

```
$ curl -sN -m 300 http://localhost:8080/v1/chat/completions ... | grep -c tool_calls
2
```

Relevant SSE chunks (tail of the stream):

```
data: {"id": "chatcmpl-adb88e67-...", ..., "choices": [{"index": 0, "finish_reason": null, "delta": {"role": "assistant", "tool_calls": [{"function": {"name": "get_weather", "arguments": "{\"city\": \"Basel\"}"}, "type": "function", "id": "6825bd57-44a8-484b-8b73-c494ba1df3ab", "index": 0}]}}]}

data: {"id": "chatcmpl-adb88e67-...", ..., "choices": [{"index": 0, "finish_reason": "tool_calls", "delta": {"role": "assistant"}}]}

data: [DONE]
```

**Pass** — `tool_calls` count is 2 (≥ 1 expected): one delta chunk carrying
the full tool call (arguments arrived in a single delta rather than
token-by-token), and the final `finish_reason: "tool_calls"` chunk.

## Step 3: Switch back to Ollama

```
$ scripts/switch-stack.sh ollama
[switch-stack] ChromaDB already running on port 8100
[switch-stack] Switching: mlx -> ollama
[switch-stack] Warming up ollama...
[switch-stack] Indexes for ollama are ready
[switch-stack] PharmaLLM is up on the ollama stack
[switch-stack] Active stack: ollama
```

**Pass** — output matches the brief's expected strings exactly
(`Indexes for ollama are ready`, `PharmaLLM is up on the ollama stack`); no
rebuild.

## Step 4: Check loopback address formats seen by Express

```
$ node data/run/loopback-probe.mjs   # temp script, deleted immediately after
127.0.0.1 -> ::ffff:127.0.0.1
[::1] -> ::1
localhost -> ::1
```

**Pass** — both remote-address formats seen (`::ffff:127.0.0.1`, `::1`) are
already in the expected set (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). No new
format requiring an update to the Task 1 / Task 5 loopback helpers.
(`localhost` resolved to the IPv6 loopback `::1` on this machine, which
Node's dual-stack `::` listener accepted; the value it reports is still
`::1`, already covered.)

## Final state

```
$ curl -s localhost:3000/api/health
{"status":"healthy","stack":"ollama","benchmark_active":false,"checks":{"llm_chat":{"status":"ok",...},"llm_embed":{"status":"ok",...},"search_index":{"status":"ok"},"chromadb":{"status":"ok",...},"searxng":{"status":"ok",...},"neo4j":{"status":"ok",...},"sqlite":{"status":"ok"}}}
```

Active stack: `ollama`. App healthy. No code or scripts were modified;
ChromaDB, `knowledge/`, `certs/`, `.claude/`, and `.firecrawl/` were left
untouched. The port-8765 review-page HTTP server was left alone.

## Overall result

All steps (1–4) passed with no deviations from expected behavior. MLX tool
calling is confirmed live for both non-streaming and streaming responses.
Task 6 (and later tasks depending on MLX tool calling) can proceed without a
follow-up. No new loopback address format was found, so no changes are
needed to the Task 1 / Task 5 loopback helper plans.

## Live verification (Task 9, 2026-09-17)

### Step 1 — restart on the new code, no token

`scripts/switch-stack.sh ollama` → `PharmaLLM is up on the ollama stack`; `/api/health` → `ollama healthy`.

### Step 2 — gateway

- `GET /v1/models` → `{"object":"list","data":[{"id":"qwen3.8-pharma",...}]}`
- `POST /v1/chat/completions` with `"model": "anything"` and a `get_weather` tool → `qwen3.8-pharma tool_calls [{"function": {"name": "get_weather", "arguments": "{\"city\":\"Basel\"}"}}]` (client model name ignored, stack model forced).

### Step 3 — real tools through the MCP service

The check script has to live inside `mcp/` (from `data/run/`, Node cannot resolve `@modelcontextprotocol/sdk`); it was a temporary file, deleted afterwards.

```
/healthz: {"ok":true,"pharmallm":true}
tools: 16
system_health ok { "status": "healthy", "stack": "ollama", "benchmark_active": false, ...
search_knowledge ok { "results": [ { "id": "news-2022-07-08-4411", ... "Dell's PowerProtect Cyber Recovery ...
graph_stats ok { "nodeCount": 582, "relationshipCount": 366, ...
reindex_status ok { "job_id": null, "status": "idle" }
```

Service log contains only tool name, outcome and duration (`[mcp] search_knowledge ok 102ms`). Service stopped by PID; port 3200 free.

Loopback-only mode (no token), from the Tailscale IP: protected route 401, localhost 200, uppercase `/V1/models` 401, browser route `/api/health` 200.

### Step 4 — token enabled (user approved)

`scripts/switch-stack.sh token` created `data/run/api-token` (`-rw-------`); app restarted on Ollama.

```
no token, localhost: 401
token, localhost: 200
no token, tailscale: 401
token, tailscale: 200
browser route, tailscale: 200
no token, localhost, uppercase /API reindex status: 401
browser chat models, https 3443 tailscale: 200
```

MCP service with `PHARMALLM_API_TOKEN` against protected routes: `reindex_status ok`, `list_knowledge_gaps ok`, `feedback_report ok`. The token string does not appear in any file under `data/logs/`.

### Step 5 — suites

Root: typecheck, typecheck:tests ok; 127 tests passed (19 suites). MCP: typecheck ok; 41 tests passed (5 suites).

## Re-verification after the final review fixes (2026-09-17)

App restarted on the fixed code (`switch-stack.sh ollama`, token enabled):

```
no token, localhost /v1/models: 401
token, localhost /v1/models: 200
no token, tailscale protected: 401
token, tailscale protected: 200
browser route, tailscale: 200
bare /api no token: 401
iPad https 3443 browser route: 200
iPad https 3443 UI page: 200
```

MCP service on the fixed code:

```
no-token mode, Host evil.example -> 403   (DNS-rebinding guard)
no-token mode, Host localhost -> 200
tools: 16
system_health ok 11ms / search_knowledge ok 105ms / reindex_status ok 3ms / list_knowledge_gaps ok 4ms
ask_pharmallm ok 23373ms (streamed answer through the body-covering deadline)
```

Node fetch 300 s limit: a throwaway loopback server withheld response headers for 310 s; the MCP client (default undici fetch with `headersTimeout: 0`, 400 s deadline) returned `PASS after 310 s: {"ok":true}`. Before the fix, Node's bundled fetch failed at ~300 s with `UND_ERR_HEADERS_TIMEOUT`.

Suites: root 135 passed, MCP 48 passed; all typechecks clean.

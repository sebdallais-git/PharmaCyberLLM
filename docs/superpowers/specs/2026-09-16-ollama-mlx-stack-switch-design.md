# Ollama / MLX Stack Switch for PharmaLLM

## Overview

Make every local-model call in PharmaLLM (chat generation and embeddings) run on exactly one of two interchangeable stacks, **Ollama** or **MLX**, selected by a single switch. The goal is a fair, measurable comparison of the two inference stacks on the Mac mini, running the same models on both.

## Decisions

| Topic | Decision |
|-------|----------|
| Exclusivity | Only one stack runs at a time. Switching stops the other stack's processes completely. |
| Scope | Whole stack: chat **and** embeddings move together. |
| Chat model | Qwen3.8 27B (`Qwen/Qwen3.8-27B`), 4-bit, on both stacks |
| Embedding model | Qwen3-Embedding-0.6B, 8-bit, on both stacks (no Qwen3.8 embedding model exists as of 2026-09-16) |
| Integration | One OpenAI-compatible client for both stacks; switching only changes base URLs and model names |
| Indexes | Separate ChromaDB collection and JSON index per stack |
| Fallback | None. If the active stack is down, requests fail with a clear error. |
| Thinking mode | Disabled on both stacks |
| Switch granularity | Process-level switch via script + app restart (no runtime UI toggle) |

## Infrastructure

**Hardware:** Mac mini M4 Pro, 48 GB unified memory, ~273 GB/s memory bandwidth.

| | Ollama stack | MLX stack |
|---|---|---|
| Process | `ollama serve` (Homebrew service, launchd `homebrew.mxcl.ollama`) | `mlx_lm.server` + `python/mlx-embed-server.py` |
| Ports | `:11434` | `:8080` (chat), `:8081` (embeddings) |
| Chat endpoint | `/v1/chat/completions` | `/v1/chat/completions` |
| Embedding endpoint | `/v1/embeddings` | `/v1/embeddings` (custom server) |
| Chat model | `qwen3.8-pharma` (Modelfile: `FROM qwen3.8:27b-q4_*` + `PARAMETER num_ctx 16384`) | `mlx-community/Qwen3.8-27B-4bit` (16.1 GB) |
| Embedding model | `qwen3-embedding:0.6b-q8_0` | `mlx-community/Qwen3-Embedding-0.6B-8bit` |
| ChromaDB collection | `knowledge_base_ollama` | `knowledge_base_mlx` |
| JSON index | `knowledge/.index.ollama.json` | `knowledge/.index.mlx.json` |

Shared, unaffected by the switch: ChromaDB (`:8100`), Neo4j, SearXNG, SQLite, whisper-node transcription.

Baseline measured before this work (Ollama, `mistral-small:24b`, ~2,700-token RAG prompt): prefill 130 tok/s (21 s TTFT), decode 16.0 tok/s.

## Architecture

```
                    LLM_PROVIDER=ollama | mlx
                              │
  chat.ts · knowledge.ts · gap-detector.ts · news-agent.ts · chromadb-store.ts · knowledge-store.ts
                              │  (import only from llm-client)
                     src/services/llm-client.ts   ← single OpenAI-compatible client
                              │  base URLs + model names from the active StackConfig
             ┌────────────────┴────────────────┐
         Ollama stack                       MLX stack
```

### Stack configuration (`src/config/llm-stacks.ts`)

```ts
export interface StackConfig {
  name: "ollama" | "mlx";
  chatBaseUrl: string;        // OLLAMA_URL | MLX_CHAT_URL
  embedBaseUrl: string;       // OLLAMA_URL | MLX_EMBED_URL
  chatModel: string;
  embeddingModel: string;
  embeddingDim: number;       // 1024
  chromaCollection: string;
  indexFile: string;
  healthChecks: string[];     // URLs probed by /api/health
}
```

`getActiveStack()` reads `LLM_PROVIDER` (default `ollama`). An unknown value throws at startup.

### LLM client (`src/services/llm-client.ts`, replaces `src/services/ollama.ts`)

- `streamChat(messages, model?, stats?)`: SSE parsing of `/v1/chat/completions` (split chunks, usage chunk, `[DONE]`)
- `chat(messages, model?, options?)`: non-streaming variant for background jobs
- `embed(text, kind: "query" | "document")`: the Qwen3-Embedding query instruction is added for `kind: "query"` only, in the client, so both stacks embed identical input
- `listModels()`: `/v1/models` of the active stack
- Timing is measured client-side, identically for both stacks: `ttftMs`, `decodeTokPerSec`, `promptTokens`, `completionTokens`
- Thinking disabled on both stacks (mechanism verified during implementation, see Verification Items)

### MLX embedding server (`python/mlx-embed-server.py`)

- Serves `/v1/embeddings` and `/v1/models` for `Qwen3-Embedding-0.6B-8bit`
- Last-token pooling, L2-normalized output, 1024 dimensions
- Uses `mlx-embeddings` if it handles Qwen3-Embedding correctly; otherwise loads the model with `mlx-lm` and pools manually

### Index metadata guard

Each ChromaDB collection (collection metadata) and JSON index file (header) records `{stack, embeddingModel, dim}`. At startup the app embeds a probe string and checks it against the active stack's index. On mismatch, search is refused with an error that suggests reindexing, instead of returning meaningless matches.

## Switching (`scripts/switch-stack.sh`)

### `switch-stack.sh ollama|mlx`

1. **Preflight:** check the target stack's models are downloaded; otherwise abort with "run `switch-stack.sh prepare`"
2. **Stop app:** SIGTERM the process on `:3000`/`:3443`, wait until the ports are free
3. **Stop current stack:**
   - Ollama: `brew services stop ollama`, then check `:11434` is closed (launchd KeepAlive restarts a killed process)
   - MLX: kill PIDs from `data/run/mlx-chat.pid` and `data/run/mlx-embed.pid`
4. **Start target stack:**
   - Ollama: `brew services start ollama`
   - MLX: `nohup` both servers, logs in `data/logs/mlx-chat.log` and `data/logs/mlx-embed.log`
5. **Wait:** poll `/v1/models` until ready (timeout 180 s)
6. **Warm up:** one small chat request and one embedding request
7. **Index check:** if the stack's collection or index file is missing or its metadata mismatches, run `reindex-stack`
8. **Start app:** `LLM_PROVIDER=<stack>`, wait for `/api/health` = `healthy`
9. **Record:** write `data/run/active-stack`

If any of steps 4–8 fails: print the relevant log tail, roll back to the previous stack, restart the app on it, exit non-zero.

### Other commands

- `switch-stack.sh prepare`: `ollama pull` both Qwen models, create `qwen3.8-pharma`, download both MLX models from Hugging Face. Never downloads during a switch.
- `switch-stack.sh status`: active stack, running processes, chunk counts for both indexes.
- `npm run dev` / `scripts/start-services.sh` start the stack recorded in `data/run/active-stack`.

## Index Synchronization

**Problem:** `news-agent.ts` ingests articles directly into the JSON index and ChromaDB without persisting their text. News ingested while one stack is active could never reach the other stack's index.

**Fix:**

- The news agent persists every ingested article to `data/raw_documents/` using the same helper as `/api/knowledge/add`
- `scripts/reindex-stack.ts` rebuilds the active stack's collection and JSON index from `knowledge/` + `data/raw_documents/`
- **One-time migration:** extract news chunks (which store their text) from the current `knowledge/.index.json` into `data/raw_documents/` before the first rebuild
- The existing `knowledge_base` collection and `knowledge/.index.json` (nomic-embed-text, 768-dim) are left untouched as a rollback, to be deleted manually later

## Error Handling

| Situation | Behavior |
|-----------|----------|
| Active stack unreachable during chat | SSE error: "MLX stack not reachable on :8080 — run `scripts/switch-stack.sh mlx`". No fallback. |
| Index/embedding mismatch | Search refused, error suggests `reindex-stack` |
| Switch fails mid-way | Log tail, automatic rollback to previous stack, non-zero exit |
| Background job while stack down | News agent / gap detector skip the run with a warning; nothing queued |
| n8n workflows | Call `POST /api/llm/complete` on PharmaLLM instead of Ollama, so they follow the active stack |
| Health | `unhealthy` if the active stack's chat or embedding endpoint is down or the search index is incompatible; `degraded` if only ChromaDB/Neo4j/SearXNG is down; the inactive stack is never probed |

## Testing

The project currently has no test runner. Per `CLAUDE.md`, add **Jest** (`ts-jest`, ESM mode, `.js` → `.ts` module mapping for `Node16` imports) with tests in `__tests__/` and `npm run test`. Tests use a fake OpenAI-compatible HTTP server (Node `http`, random port), never real models.

| Test | Covers |
|------|--------|
| `__tests__/llm-stacks.test.ts` | Stack selection from `LLM_PROVIDER`; unknown value throws |
| `__tests__/llm-client.test.ts` | SSE parsing (split chunks, usage chunk, `[DONE]`); TTFT and tok/s with an injected clock; query-only instruction prefix; unreachable stack → clear error, no fallback |
| `__tests__/index-guard.test.ts` | Metadata mismatch refuses search |
| `__tests__/health.test.ts` | Stack-aware health aggregation; inactive stack not probed |
| `__tests__/news-agent.test.ts` | Ingested articles persisted to `data/raw_documents/` |

**Smoke checks (scripted, not unit tests):**

- **MLX embedding server:** 1024 dimensions, normalized, deterministic, a relevant document ranks above an unrelated one
- **Cross-stack embedding parity:** embed 20 fixed texts on stack A and save, switch, embed on stack B, require mean cosine similarity ≥ 0.98. The stacks run sequentially, never concurrently.
- **Switch round trip:** Ollama → MLX → Ollama with a chat after each; forced failure confirms rollback

`npm run typecheck` must pass after every change.

## Benchmark

### `scripts/benchmark-stack.ts`

Runs the full pipeline through the app (`POST /api/chat`) on the active stack.

- **Question set:** `bench/questions.json`, ~20 questions across vendors, threats, regulations, and pharma sites, plus 3 not covered by the knowledge base
- **Benchmark mode:** request flag `benchmark: true` sets temperature 0, disables web search, and skips the post-answer gap detection and request logging. (`response-cache.ts` only stores feedback metadata and never answers repeated questions, so no cache bypass is needed.) While benchmarking, the news agent and other background LLM jobs are paused.
- **Per-phase timings:** the final SSE `done` event gains `timings: { embedMs, retrievalMs, ttftMs, decodeTokPerSec, promptTokens, completionTokens, totalMs }`
- **Protocol:** one discarded warm-up, then 3 runs per question; report median and p90
- **Also recorded:**
  - peak RSS of the stack's processes
  - retrieved chunk IDs per question
  - environment: stack versions (`ollama --version`, `mlx`/`mlx-lm`), model IDs, macOS version, thermal state
- **Output:** `data/benchmarks/<stack>-<timestamp>.json`

### `scripts/compare-benchmarks.ts <a.json> <b.json>`

- **Performance table:** TTFT, decode tok/s, total latency, peak memory, with MLX delta %
- **Retrieval overlap:** Jaccard similarity of retrieved chunk IDs per question
- **Blind A/B review:** an HTML page with the two answers side by side, stack labels hidden and order randomized. The user picks better, worse, or tie; results are revealed at the end. No LLM-as-judge, because a Qwen judge would be biased and can't reliably detect subtle quantization-related quality loss.

## New Files

- `src/config/llm-stacks.ts`
- `src/services/llm-client.ts`
- `python/mlx-embed-server.py`
- `scripts/switch-stack.sh`
- `scripts/reindex-stack.ts`
- `scripts/migrate-news-to-raw-documents.ts`
- `scripts/benchmark-stack.ts`
- `scripts/compare-benchmarks.ts`
- `bench/questions.json`
- `jest.config.js`
- `__tests__/*.test.ts` (see Testing)

## Modified Files

| File | Change |
|------|--------|
| `src/services/ollama.ts` | Removed (replaced by `llm-client.ts`) |
| `src/api/chat.ts` | Use `llm-client`; model default from active stack; `benchmark` flag; `timings` in `done` event |
| `src/api/knowledge.ts` | Use `llm-client`; reindex targets active stack |
| `src/api/dashboard.ts` | Stack-aware `/api/health` including `stack` field |
| `src/services/gap-detector.ts` | Use `llm-client`; skip run when stack down |
| `src/services/news-agent.ts` | Use `llm-client`; persist raw documents; skip run when stack down |
| `src/services/chromadb-store.ts` | Collection name + metadata from active stack; metadata guard |
| `src/services/knowledge-store.ts` | Index file from active stack; metadata header; guard |
| `src/server.ts` | Startup guard; pausable schedulers |
| `public/app.js` | Default model from server; stats line shows stack, TTFT, tok/s |
| `scripts/start-services.sh` | Start stack from `data/run/active-stack` |
| `scripts/ingest-to-chromadb.ts` | Use active stack's collection and embeddings |
| `package.json` | `test` script, Jest dev dependencies |
| `README.md` | Stack switch, prepare, benchmark usage |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `ollama` | Active stack |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `MLX_CHAT_URL` | `http://localhost:8080` | mlx_lm.server base URL |
| `MLX_EMBED_URL` | `http://localhost:8081` | MLX embedding server base URL |

`EMBEDDING_MODEL` is superseded by the stack configuration.

## Verification Items (resolve at start of implementation)

1. Exact Ollama tag for Qwen3.8 27B at 4-bit (`qwen3.8:27b-q4_*`), and that Ollama 0.17.6 can run it; upgrade Ollama if required
2. The `qwen3.8-pharma` Modelfile `num_ctx` is honored by Ollama's `/v1/chat/completions`
3. Mechanism to disable thinking on each stack via the OpenAI-compatible API (Ollama; `mlx_lm.server` chat template kwargs)
4. `mlx_lm.server` supports Qwen3.8's architecture with the installed/pinned `mlx-lm` version, and reports usage in streaming responses. Qwen3.8 reuses the Qwen3.5 architecture code: its `config.json` declares `model_type: qwen3_5` / `Qwen3_5ForConditionalGeneration` while `base_model` is `Qwen/Qwen3.8-27B`.
5. `mlx-embeddings` produces correct Qwen3-Embedding vectors (last-token pooling), else fall back to `mlx-lm` pooling
6. Port `:8080` and `:8081` are free on the host

## Preconditions

- `main` has uncommitted work in `src/api/chat.ts`, `src/services/*.ts`, and `public/*`, which this design modifies. Commit or stash it before implementation starts.
- Work happens on branch `feature/ollama-mlx-stack-switch`.

## Out of Scope

- Running both stacks concurrently
- Runtime stack toggle from the UI
- Multi-token prediction (MTP) variants (a later benchmark round, same setting on both stacks)
- Whisper transcription stack changes
- Deleting the legacy `knowledge_base` collection and `.index.json`

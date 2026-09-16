# Ollama / MLX Stack Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every local-model call in PharmaLLM (chat and embeddings) through exactly one of two interchangeable stacks, Ollama or MLX, both running Qwen3.8 27B 4-bit and Qwen3-Embedding-0.6B 8-bit, and benchmark them fairly.

**Architecture:** A single OpenAI-compatible client (`src/services/llm-client.ts`) talks to whichever stack `LLM_PROVIDER` selects (`src/config/llm-stacks.ts`). Each stack has its own ChromaDB collection and JSON index, stamped with `{stack, embeddingModel, dim}` and checked at startup. `scripts/switch-stack.sh` stops one stack, starts the other, rebuilds indexes when needed, restarts the app, and rolls back on failure. Benchmarks run through the app's own `/api/chat` with per-phase timings.

**Tech Stack:** Node 22, TypeScript (strict, ESM, `Node16` modules), Express 4, ChromaDB REST v2, Jest 30 + ts-jest (ESM), Ollama (Homebrew service), `mlx-lm==0.31.3` in `python/mlx-venv`, Bash.

**Spec:** `docs/superpowers/specs/2026-09-16-ollama-mlx-stack-switch-design.md`

## Planning Notes (facts found while planning that refine the spec)

1. **No answer cache exists.** `src/services/response-cache.ts` only stores response metadata for feedback, so it never answers a repeated question. Benchmark mode therefore needs no cache bypass. It does need to skip the background gap-detection LLM call that `chat.ts` fires after every answer, which would otherwise compete for the GPU during the next question.
2. **The legacy index is large and inconsistent.** `knowledge/.index.json` is 361 MB (pretty-printed JSON). It holds 11,680 chunks (10,768 of them news) with mixed vector sizes: 10,271 × 768, 1,328 × 3,584, 81 × 8,192. Mismatched vectors score 0 in `cosineSimilarity`, so about 1,400 chunks are silently unsearchable today. New index files store embeddings as base64 Float32 in compact JSON.
3. **News was never persisted as raw text.** The legacy ChromaDB `knowledge_base` collection holds 7,043 chunks (6,869 news). All articles from one day share a source name (`news-YYYY-MM-DD`), so raw documents for news are keyed by article URL, not source.
4. **n8n workflows call Ollama directly.** `n8n/knowledge_gap_workflow.json`, `n8n/knowledge_gap_workflow_v2.json` and `n8n/knowledge_qa_workflow.json` POST to `http://localhost:11434/api/generate` with `gemma2:9b`. With MLX active, Ollama is stopped and these break. **Decision (confirmed by the user):** the workflows must work with either stack. Add `POST /api/llm/complete` to PharmaLLM, which answers on the active stack (Ollama or MLX) with an Ollama-shaped `{ response }` body, and point the n8n nodes at it (Task 12).
5. **Verification items resolved from official sources:**
   - Ollama tag: `qwen3.8:27b-q4_K_M` (Ollama 0.17.6 support still to be confirmed in Task 0).
   - Ollama's OpenAI API ignores per-request context size; a Modelfile with `PARAMETER num_ctx` is the documented fix.
   - Thinking off: Ollama `reasoning_effort: "none"`; `mlx_lm.server` per-request `chat_template_kwargs: {"enable_thinking": false}`.
   - Both servers support `stream_options.include_usage`; Ollama serves `/v1/embeddings`.
   - `mlx-lm` 0.31.3 ships `mlx_lm/models/qwen3_5.py` (Qwen3.8's architecture).
   - Qwen3-Embedding-0.6B is a `Qwen3ForCausalLM` (hidden size 1024, EOS 151643). The MLX embedding server uses `mlx-lm` directly with last-token pooling instead of `mlx-embeddings`.
   - Ports 8080 and 8081 are free.
6. **Small spec adjustments:**
   - `/api/health` also reports a `search_index` check, treated as critical because chat refuses to answer on an incompatible index.
   - `StackConfig` has no `healthChecks` field; probe URLs derive from the base URLs.
   - The Ollama Modelfile is committed at `ollama/qwen3.8-pharma.Modelfile`.
   - Raw-document persistence is tested in `__tests__/raw-documents.test.ts` rather than through the network-bound news agent.

## Global Constraints

- TypeScript strict mode; ES modules with `.js` import specifiers; no `any` (use `unknown` + type guards); prefer `interface` over `type` aliases except for unions.
- camelCase functions, PascalCase classes, kebab-case file names.
- Code comments in English, matching the surrounding comment density.
- Run `npm run typecheck` after every code change; every new module gets Jest tests in `__tests__/`.
- Never modify `.env` files.
- Commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`. End every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Work on branch `feature/ollama-mlx-stack-switch`.
- **Only one stack runs at a time.** Never start MLX servers while Ollama listens on `:11434`, or Ollama while `:8080`/`:8081` are open.
- **No fallback between stacks.** If the active stack is down, fail with a clear error.
- Model names: Ollama chat `qwen3.8-pharma` (built from `qwen3.8:27b-q4_K_M`, `num_ctx 16384`), Ollama embeddings `qwen3-embedding:0.6b-q8_0`; MLX chat `mlx-community/Qwen3.8-27B-4bit`, MLX embeddings `mlx-community/Qwen3-Embedding-0.6B-8bit`. Embedding dimension 1024.
- Ports: app 3000/3443, Ollama 11434, MLX chat 8080, MLX embeddings 8081, ChromaDB 8100.
- Collections/index files: `knowledge_base_ollama` + `knowledge/.index.ollama.json`; `knowledge_base_mlx` + `knowledge/.index.mlx.json`. Leave the legacy `knowledge_base` collection and `knowledge/.index.json` untouched.

## File Map

| File | Responsibility |
|------|----------------|
| `src/config/llm-stacks.ts` (new) | Stack definitions and `LLM_PROVIDER` selection |
| `src/services/llm-client.ts` (new, replaces `ollama.ts`) | OpenAI-compatible chat, streaming, embeddings, model list, reachability, client-side timing |
| `src/services/index-guard.ts` (new) | Index metadata, compatibility checks, runtime index status |
| `src/services/raw-documents.ts` (new) | Raw document persistence and listing |
| `src/services/bench-mode.ts` (new) | Benchmark flag, running-job tracking, `ChatTimings` type |
| `src/services/health.ts` (new) | Stack-aware probes and health aggregation |
| `src/services/reindex.ts` (new) | Rebuild/inspect the active stack's indexes |
| `src/utils/batches.ts` (new) | `toBatches` helper |
| `src/api/bench.ts` (new) | `/api/bench/start|stop|status` |
| `src/api/llm.ts` (new) | `/api/llm/complete` for n8n |
| `src/services/knowledge-store.ts` | Per-stack index file, v2 format, batched embeddings |
| `src/services/chromadb-store.ts` | Per-stack collection with metadata, batched upserts |
| `src/api/chat.ts`, `src/api/knowledge.ts`, `src/api/dashboard.ts` | Use the client, timings, benchmark mode, health |
| `src/services/gap-detector.ts`, `src/services/news-agent.ts` | Use the client, job tracking, skip rules, raw docs |
| `src/server.ts` | Startup index verification, new routers |
| `public/app.js`, `dashboard/index.html` | Stack-aware models, stats line, health cards |
| `python/mlx-embed-server.py`, `python/mlx-requirements.txt`, `python/smoke_embeddings.py` (new) | MLX embedding server and endpoint smoke test |
| `ollama/qwen3.8-pharma.Modelfile` (new) | Ollama chat model with 16k context |
| `scripts/lib/services.sh`, `scripts/switch-stack.sh` (new); `scripts/start-services.sh` | Process management |
| `scripts/reindex-stack.ts`, `scripts/migrate-news-to-raw-documents.ts`, `scripts/embedding-parity.ts`, `scripts/benchmark-stack.ts`, `scripts/compare-benchmarks.ts` (new) | Operational scripts |
| `scripts/lib/stats.ts`, `scripts/lib/legacy-news.ts`, `scripts/lib/benchmark-types.ts` (new) | Testable script logic |
| `bench/questions.json` (new) | Benchmark question set |
| `n8n/*.json` | Call `/api/llm/complete` instead of Ollama |
| `jest.config.js`, `tsconfig.test.json` (new); `package.json`, `.gitignore`, `README.md` | Tooling and docs |

---

### Task 0: Preconditions and verification spike

No code. Confirms the remaining assumptions on the real machine before anything is built.

**Files:**
- Create: `docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md`

- [ ] **Step 1: Resolve uncommitted work**

Run: `git status --short`
Expected: modified files under `src/`, `public/`, `knowledge/` and others from before this feature.

Ask the user whether to **commit** that work (recommended: the code excerpts in this plan were taken from the current working tree) or **stash** it. Do not choose for them. If they stash, re-read `src/api/chat.ts`, `src/services/*.ts`, `public/app.js` and `dashboard/index.html` before Task 5, because the anchors quoted in later tasks may differ.

Then confirm the branch:

Run: `git branch --show-current`
Expected: `feature/ollama-mlx-stack-switch`

- [ ] **Step 2: Tell the user the app will lose its LLM during the spike**

Steps 5–7 stop Ollama. The running PharmaLLM (currently on `mistral-small:24b`) cannot answer until Step 8 restarts Ollama.

- [ ] **Step 3: Pull the Ollama models**

```bash
ollama pull qwen3.8:27b-q4_K_M
ollama pull qwen3-embedding:0.6b-q8_0
```

Expected: both end with `success`. If the pull or a later request fails with a message that the model requires a newer Ollama, run:

```bash
brew upgrade ollama && brew services restart ollama
```

then repeat the pulls and record the new `ollama --version`.

- [ ] **Step 4: Create the context-length model and check Ollama's OpenAI API**

```bash
mkdir -p ollama
cat > ollama/qwen3.8-pharma.Modelfile <<'EOF'
# Qwen3.8 27B (Q4_K_M) with the 16k context PharmaLLM uses; Ollama's OpenAI API can't set num_ctx per request
FROM qwen3.8:27b-q4_K_M
PARAMETER num_ctx 16384
EOF
ollama create qwen3.8-pharma -f ollama/qwen3.8-pharma.Modelfile
ollama show qwen3.8-pharma --parameters
```

Expected: `num_ctx 16384` in the output.

```bash
curl -sN http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "qwen3.8-pharma", "stream": true, "stream_options": {"include_usage": true},
  "reasoning_effort": "none", "max_tokens": 40,
  "messages": [{"role": "user", "content": "Name one GLP-1 drug."}]}' | tail -n 5
ollama ps
curl -s http://localhost:11434/v1/embeddings -H 'Content-Type: application/json' \
  -d '{"model": "qwen3-embedding:0.6b-q8_0", "input": ["test"]}' \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"][0]["embedding"]))'
```

Expected:
- Streamed `data:` lines with `delta.content`, no `<think>` text and no `reasoning` deltas.
- A final chunk with `"usage": {"prompt_tokens": …, "completion_tokens": …}` followed by `data: [DONE]`.
- `ollama ps` shows `qwen3.8-pharma` with CONTEXT `16384`.
- The embedding length prints `1024`.

- [ ] **Step 5: Create the MLX virtual environment**

```bash
python3 -m venv python/mlx-venv
python/mlx-venv/bin/pip install mlx-lm==0.31.3
python/mlx-venv/bin/python -c "import importlib.metadata as m; print(m.version('mlx'), m.version('mlx-lm'))"
```

Expected: two version numbers, the second `0.31.3`. If installation fails on Python 3.14 (for example, a dependency without a 3.14 wheel), run `brew install python@3.12`, delete `python/mlx-venv`, recreate it with `/opt/homebrew/bin/python3.12 -m venv python/mlx-venv`, and record that `MLX_PYTHON=/opt/homebrew/bin/python3.12` is required (Task 15 uses it).

- [ ] **Step 6: Download the MLX models**

```bash
python/mlx-venv/bin/python -c "from huggingface_hub import snapshot_download as d; d('mlx-community/Qwen3.8-27B-4bit'); d('mlx-community/Qwen3-Embedding-0.6B-8bit')"
ls ~/.cache/huggingface/hub | grep -E 'Qwen3.8-27B-4bit|Qwen3-Embedding-0.6B-8bit'
```

Expected: both `models--mlx-community--…` directories listed.

- [ ] **Step 7: Check mlx_lm.server with Ollama stopped**

```bash
brew services stop ollama
sleep 3; nc -z localhost 11434 && echo "STILL UP" || echo "ollama down"
python/mlx-venv/bin/mlx_lm.server --model mlx-community/Qwen3.8-27B-4bit --host 127.0.0.1 --port 8080 > /tmp/mlx-spike.log 2>&1 &
echo $! > /tmp/mlx-spike.pid
until curl -sf http://localhost:8080/v1/models > /dev/null; do sleep 2; done
curl -sN http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "mlx-community/Qwen3.8-27B-4bit", "stream": true, "stream_options": {"include_usage": true},
  "chat_template_kwargs": {"enable_thinking": false}, "max_tokens": 40,
  "messages": [{"role": "user", "content": "Name one GLP-1 drug."}]}' | tail -n 5
kill "$(cat /tmp/mlx-spike.pid)"
```

Expected:
- `ollama down`.
- The model loads (the log shows no architecture error for `qwen3_5`).
- Streamed content without `<think>`, and a final chunk containing `usage` before `[DONE]`.

If the model fails to load, stop and report the log to the user. The MLX side of the design depends on it.

- [ ] **Step 8: Restart Ollama**

```bash
brew services start ollama
until curl -sf http://localhost:11434/v1/models > /dev/null; do sleep 1; done; echo "ollama up"
```

Expected: `ollama up`.

- [ ] **Step 9: Record the results**

Write `docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md` with one section per step (3–7): the command, the observed output excerpt, and pass/fail. Include `ollama --version`, the MLX versions, and whether `MLX_PYTHON` is needed. If any expectation failed, stop and ask the user how to proceed.

- [ ] **Step 10: Commit**

```bash
git add ollama/qwen3.8-pharma.Modelfile docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md
git commit -m "docs: record stack switch verification spike results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Jest test harness

**Files:**
- Create: `jest.config.js`, `tsconfig.test.json`, `__tests__/harness.test.ts`
- Modify: `package.json` (scripts, devDependencies), `.gitignore`

**Interfaces:**
- Produces: `npm run test` (Jest in ESM mode, tests in `__tests__/**/*.test.ts`); `npm run typecheck:tests`.

- [ ] **Step 1: Install Jest**

```bash
npm install -D jest@30 ts-jest@29 @jest/globals@30
```

Expected: installs without peer-dependency errors (`ts-jest@29.4` declares `jest ^29 || ^30`). If npm reports a conflict, use `jest@29 @jest/globals@29` instead.

- [ ] **Step 2: Add the Jest config**

Create `jest.config.js`:

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
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.test.json" }],
  },
};
```

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": [
    "src/**/*",
    "__tests__/**/*",
    "scripts/lib/**/*",
    "scripts/reindex-stack.ts",
    "scripts/migrate-news-to-raw-documents.ts",
    "scripts/embedding-parity.ts",
    "scripts/benchmark-stack.ts",
    "scripts/compare-benchmarks.ts"
  ]
}
```

- [ ] **Step 3: Add scripts**

In `package.json`, replace the `"scripts"` block with:

```json
  "scripts": {
    "build": "tsc",
    "dev": "./scripts/start-services.sh",
    "dev:node": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json",
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
  },
```

- [ ] **Step 4: Write a harness test that imports a real ESM module**

Create `__tests__/harness.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { isSupportedFile } from "../src/services/file-parser.js";

describe("test harness", () => {
  it("loads ESM source modules that use import.meta and .js specifiers", () => {
    expect(isSupportedFile("notes.md")).toBe(true);
    expect(isSupportedFile("image.png")).toBe(false);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm run test`
Expected: `Tests: 1 passed` (1 suite). If ts-jest reports `import.meta` errors, confirm `tsconfig.test.json` extends `module: "Node16"` and `useESM: true` is set.

- [ ] **Step 6: Ignore generated stack artifacts**

Append to `.gitignore`:

```
knowledge/.index.*.json
python/mlx-venv/
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck && npm run typecheck:tests`
Expected: no output, exit 0.

```bash
git add jest.config.js tsconfig.test.json __tests__/harness.test.ts package.json package-lock.json .gitignore
git commit -m "test: add Jest ESM harness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stack configuration

**Files:**
- Create: `src/config/llm-stacks.ts`
- Test: `__tests__/llm-stacks.test.ts`

**Interfaces:**
- Produces:
  - `type StackName = "ollama" | "mlx"`
  - `interface StackConfig { name: StackName; chatBaseUrl: string; embedBaseUrl: string; chatModel: string; embeddingModel: string; embeddingDim: number; chromaCollection: string; indexFile: string; chatExtraBody: Record<string, unknown> }`
  - `buildStacks(env?: NodeJS.ProcessEnv): Record<StackName, StackConfig>`
  - `getActiveStack(env?: NodeJS.ProcessEnv): StackConfig` (throws on an unknown `LLM_PROVIDER`)

- [ ] **Step 1: Write the failing test**

Create `__tests__/llm-stacks.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { buildStacks, getActiveStack } from "../src/config/llm-stacks.js";

describe("getActiveStack", () => {
  it("defaults to the ollama stack", () => {
    expect(getActiveStack({}).name).toBe("ollama");
  });

  it("selects the mlx stack", () => {
    const stack = getActiveStack({ LLM_PROVIDER: "mlx" });
    expect(stack.name).toBe("mlx");
    expect(stack.chatModel).toBe("mlx-community/Qwen3.8-27B-4bit");
    expect(stack.embeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  it("throws on an unknown provider", () => {
    expect(() => getActiveStack({ LLM_PROVIDER: "lmstudio" })).toThrow('Invalid LLM_PROVIDER "lmstudio"');
  });
});

describe("buildStacks", () => {
  it("honours URL overrides", () => {
    const stacks = buildStacks({ OLLAMA_URL: "http://o:1", MLX_CHAT_URL: "http://m:2", MLX_EMBED_URL: "http://e:3" });
    expect(stacks.ollama.chatBaseUrl).toBe("http://o:1");
    expect(stacks.ollama.embedBaseUrl).toBe("http://o:1");
    expect(stacks.mlx.chatBaseUrl).toBe("http://m:2");
    expect(stacks.mlx.embedBaseUrl).toBe("http://e:3");
  });

  it("uses the same model family on both stacks and separate indexes", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.chatModel).toBe("qwen3.8-pharma");
    expect(ollama.embeddingModel).toBe("qwen3-embedding:0.6b-q8_0");
    expect(ollama.embeddingDim).toBe(1024);
    expect(mlx.embeddingDim).toBe(1024);
    expect(ollama.chromaCollection).toBe("knowledge_base_ollama");
    expect(mlx.chromaCollection).toBe("knowledge_base_mlx");
    expect(ollama.indexFile).toBe(".index.ollama.json");
    expect(mlx.indexFile).toBe(".index.mlx.json");
  });

  it("disables thinking on both stacks", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.chatExtraBody).toEqual({ reasoning_effort: "none" });
    expect(mlx.chatExtraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- __tests__/llm-stacks.test.ts`
Expected: FAIL with `Cannot find module '../src/config/llm-stacks.js'`.

- [ ] **Step 3: Implement**

Create `src/config/llm-stacks.ts`:

```ts
// Stack definitions for the Ollama / MLX switch. Exactly one stack is active per process.

export type StackName = "ollama" | "mlx";

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
  };
}

export function getActiveStack(env: NodeJS.ProcessEnv = process.env): StackConfig {
  const name = env.LLM_PROVIDER ?? "ollama";
  if (name !== "ollama" && name !== "mlx") {
    throw new Error(`Invalid LLM_PROVIDER "${name}" (expected "ollama" or "mlx")`);
  }
  return buildStacks(env)[name];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- __tests__/llm-stacks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/config/llm-stacks.ts __tests__/llm-stacks.test.ts
git commit -m "feat: add Ollama/MLX stack configuration

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: OpenAI-compatible LLM client

**Files:**
- Create: `src/services/llm-client.ts`, `__tests__/helpers/fake-openai-server.ts`
- Test: `__tests__/llm-client.test.ts`

**Interfaces:**
- Consumes: `StackConfig`, `getActiveStack()` from Task 2.
- Produces (all exported from `src/services/llm-client.ts`):
  - `interface ChatMessage { role: "system" | "user" | "assistant"; content: string }`
  - `interface ChatOptions { model?: string; temperature?: number }`
  - `interface TokenStats { promptTokens: number; completionTokens: number; tokensPerSecond: number; ttftMs: number; tokenCountSource: "usage" | "chunks" }`
  - `interface StatsCollector { result?: TokenStats }`
  - `type EmbedKind = "query" | "document"`
  - `interface LlmClient { readonly stack: StackConfig; streamChat(messages, options?, stats?): AsyncGenerator<string>; chat(messages, options?): Promise<string>; embed(text, kind): Promise<number[]>; embedMany(texts, kind): Promise<number[][]>; listModels(): Promise<string[]>; isReachable(): Promise<boolean> }`
  - `class StackUnavailableError extends Error`
  - `const QUERY_INSTRUCTION: string`, `formatEmbeddingInput(text, kind): string`
  - `parseSseLines(buffer: string): { events: string[]; rest: string }`
  - `computeTokenStats(input: TimingInput): TokenStats`
  - `createLlmClient(stack: StackConfig, now?: () => number): LlmClient`
  - `getLlmClient(): LlmClient` (lazy singleton for the active stack)
- Test helper produces: `startFakeServer(handler): Promise<FakeServer>` with `FakeServer { baseUrl; requests: RecordedRequest[]; close() }`.

- [ ] **Step 1: Write the fake server helper**

Create `__tests__/helpers/fake-openai-server.ts`:

```ts
// Minimal HTTP server that stands in for an OpenAI-compatible model server in tests

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeServer(
  handler: (req: RecordedRequest, res: ServerResponse) => void
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as unknown) : null,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // fetch keeps connections alive; drop them so close() doesn't wait
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function sendSse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
```

- [ ] **Step 2: Write the failing tests**

Create `__tests__/llm-client.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import type { StackConfig } from "../src/config/llm-stacks.js";
import {
  QUERY_INSTRUCTION,
  StackUnavailableError,
  computeTokenStats,
  createLlmClient,
  formatEmbeddingInput,
  parseSseLines,
} from "../src/services/llm-client.js";
import type { StatsCollector } from "../src/services/llm-client.js";
import { sendJson, sendSse, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

const CLOSED_URL = "http://127.0.0.1:9";

function stackFor(baseUrl: string): StackConfig {
  return { ...buildStacks({}).mlx, chatBaseUrl: baseUrl, embedBaseUrl: baseUrl };
}

function delta(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("parseSseLines", () => {
  it("keeps an incomplete trailing line for the next read", () => {
    const first = parseSseLines('data: {"a":1}\n\ndata: {"b"');
    expect(first.events).toEqual(['{"a":1}']);
    const second = parseSseLines(first.rest + ":2}\n\n");
    expect(second.events).toEqual(['{"b":2}']);
    expect(second.rest).toBe("");
  });

  it("ignores comments and blank lines", () => {
    expect(parseSseLines(": keep-alive\n\ndata: [DONE]\n").events).toEqual(["[DONE]"]);
  });
});

describe("computeTokenStats", () => {
  it("measures TTFT and decode speed excluding the first token", () => {
    const stats = computeTokenStats({
      start: 1000,
      firstTokenAt: 1400,
      lastTokenAt: 1900,
      contentChunks: 6,
      usage: { prompt_tokens: 120, completion_tokens: 11 },
    });
    expect(stats.ttftMs).toBe(400);
    expect(stats.tokensPerSecond).toBeCloseTo(20); // 10 tokens after the first, in 500 ms
    expect(stats.promptTokens).toBe(120);
    expect(stats.completionTokens).toBe(11);
    expect(stats.tokenCountSource).toBe("usage");
  });

  it("counts content chunks when the server sends no usage", () => {
    const stats = computeTokenStats({ start: 0, firstTokenAt: 100, lastTokenAt: 300, contentChunks: 5, usage: null });
    expect(stats.completionTokens).toBe(5);
    expect(stats.tokensPerSecond).toBeCloseTo(20); // 4 tokens in 200 ms
    expect(stats.tokenCountSource).toBe("chunks");
  });

  it("reports zero when nothing was generated", () => {
    const stats = computeTokenStats({ start: 0, firstTokenAt: null, lastTokenAt: 0, contentChunks: 0, usage: null });
    expect(stats.ttftMs).toBe(0);
    expect(stats.tokensPerSecond).toBe(0);
  });
});

describe("formatEmbeddingInput", () => {
  it("adds the retrieval instruction to queries only", () => {
    expect(formatEmbeddingInput("What is SafeMode?", "query")).toBe(
      `Instruct: ${QUERY_INSTRUCTION}\nQuery:What is SafeMode?`
    );
    expect(formatEmbeddingInput("SafeMode snapshots are immutable.", "document")).toBe(
      "SafeMode snapshots are immutable."
    );
  });
});

describe("createLlmClient", () => {
  it("streams tokens, sends the stack's request fields, and collects stats", async () => {
    server = await startFakeServer((_req, res) =>
      sendSse(res, [
        delta("Hel"),
        delta("lo"),
        { choices: [], usage: { prompt_tokens: 42, completion_tokens: 2 } },
      ])
    );
    const ticks = [0, 250, 350];
    const client = createLlmClient(stackFor(server.baseUrl), () => ticks.shift() ?? 350);
    const stats: StatsCollector = {};
    const tokens: string[] = [];

    for await (const token of client.streamChat([{ role: "user", content: "hi" }], { temperature: 0 }, stats)) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(server.requests[0].url).toBe("/v1/chat/completions");
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.model).toBe("mlx-community/Qwen3.8-27B-4bit");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(stats.result).toEqual({
      promptTokens: 42,
      completionTokens: 2,
      tokensPerSecond: 10,
      ttftMs: 250,
      tokenCountSource: "usage",
    });
  });

  it("returns non-streaming content with the default temperature", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { choices: [{ message: { content: "pong" } }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.chat([{ role: "user", content: "ping" }])).resolves.toBe("pong");
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.3);
  });

  it("returns embeddings in input order", async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, 200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })
    );
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.embedMany(["a", "b"], "document")).resolves.toEqual([[1, 0], [0, 1]]);
    expect(server.requests[0].url).toBe("/v1/embeddings");
    const body = server.requests[0].body as { model: string; input: string[] };
    expect(body.model).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
    expect(body.input).toEqual(["a", "b"]);
  });

  it("rejects a response with the wrong number of embeddings", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { data: [{ index: 0, embedding: [1] }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.embedMany(["a", "b"], "document")).rejects.toThrow("expected 2 embeddings, got 1");
  });

  it("lists models and reports reachability", async () => {
    server = await startFakeServer((_req, res) => sendJson(res, 200, { data: [{ id: "x" }, { id: "y" }] }));
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.listModels()).resolves.toEqual(["x", "y"]);
    await expect(client.isReachable()).resolves.toBe(true);
    await expect(createLlmClient(stackFor(CLOSED_URL)).isReachable()).resolves.toBe(false);
  });

  it("fails with a clear error and no fallback when the stack is down", async () => {
    const client = createLlmClient(stackFor(CLOSED_URL));

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(StackUnavailableError);
    await expect(client.embed("hi", "query")).rejects.toThrow(
      `MLX stack not reachable at ${CLOSED_URL}/v1/embeddings — run scripts/switch-stack.sh mlx`
    );
  });

  it("surfaces HTTP errors with status and body", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("model not loaded");
    });
    const client = createLlmClient(stackFor(server.baseUrl));

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      "mlx /v1/chat/completions failed (500): model not loaded"
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -- __tests__/llm-client.test.ts`
Expected: FAIL with `Cannot find module '../src/services/llm-client.js'`.

- [ ] **Step 4: Implement the client**

Create `src/services/llm-client.ts`:

```ts
// OpenAI-compatible client shared by the Ollama and MLX stacks.
// Both stacks go through this exact code path, so timings are measured the same way.

import { getActiveStack } from "../config/llm-stacks.js";
import type { StackConfig } from "../config/llm-stacks.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
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
  choices?: Array<{ delta?: { content?: string | null } }>;
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
      model: options.model ?? stack.chatModel,
      messages,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...stack.chatExtraBody,
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

    if (finished) await reader.cancel().catch(() => {});
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- __tests__/llm-client.test.ts`
Expected: PASS, 13 tests, and Jest exits without an "open handles" warning.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck && npm run typecheck:tests`
Expected: exit 0.

```bash
git add src/services/llm-client.ts __tests__/helpers/fake-openai-server.ts __tests__/llm-client.test.ts
git commit -m "feat: add OpenAI-compatible LLM client shared by both stacks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Index guard

**Files:**
- Create: `src/services/index-guard.ts`
- Test: `__tests__/index-guard.test.ts`

**Interfaces:**
- Consumes: `StackConfig` (Task 2).
- Produces:
  - `interface IndexMeta { stack: string; embeddingModel: string; dim: number }`
  - `interface IndexCheck { ok: boolean; reason: string }`
  - `expectedIndexMeta(stack: StackConfig): IndexMeta`
  - `checkIndexMeta(expected: IndexMeta, actual: IndexMeta | null, probeDim: number | null, label: string): IndexCheck`
  - `indexMetaFromChroma(metadata: Record<string, unknown> | null | undefined): IndexMeta | null`
  - `indexMetaToChroma(meta: IndexMeta): Record<string, string | number>`
  - `setIndexStatus(check: IndexCheck): void`, `getIndexStatus(): IndexCheck`, `assertIndexUsable(): void`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/index-guard.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import {
  assertIndexUsable,
  checkIndexMeta,
  expectedIndexMeta,
  indexMetaFromChroma,
  indexMetaToChroma,
  setIndexStatus,
} from "../src/services/index-guard.js";

const expected = expectedIndexMeta(buildStacks({}).mlx);

describe("expectedIndexMeta", () => {
  it("describes the stack's embedding space", () => {
    expect(expected).toEqual({ stack: "mlx", embeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit", dim: 1024 });
  });
});

describe("checkIndexMeta", () => {
  it("accepts a matching index", () => {
    expect(checkIndexMeta(expected, { ...expected }, 1024, "ChromaDB collection")).toEqual({ ok: true, reason: "" });
  });

  it("rejects an index without metadata", () => {
    const check = checkIndexMeta(expected, null, null, "in-memory index");
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("in-memory index: index has no stack metadata — run scripts/reindex-stack.ts");
  });

  it("lists every mismatching field", () => {
    const check = checkIndexMeta(
      expected,
      { stack: "ollama", embeddingModel: "nomic-embed-text", dim: 768 },
      null,
      "ChromaDB collection"
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("stack ollama ≠ mlx");
    expect(check.reason).toContain("embedding model nomic-embed-text ≠ mlx-community/Qwen3-Embedding-0.6B-8bit");
    expect(check.reason).toContain("dim 768 ≠ 1024");
  });

  it("rejects an embedding server that returns the wrong dimension", () => {
    const check = checkIndexMeta(expected, { ...expected }, 768, "in-memory index");
    expect(check).toEqual({ ok: false, reason: "in-memory index: embedding server returned 768 dimensions, expected 1024" });
  });
});

describe("Chroma metadata", () => {
  it("round-trips index metadata", () => {
    const chroma = { "hnsw:space": "cosine", ...indexMetaToChroma(expected) };
    expect(indexMetaFromChroma(chroma)).toEqual(expected);
  });

  it("returns null for collections created before the stack switch", () => {
    expect(indexMetaFromChroma({ "hnsw:space": "cosine" })).toBeNull();
    expect(indexMetaFromChroma(null)).toBeNull();
  });
});

describe("assertIndexUsable", () => {
  it("throws while the index is incompatible and passes once it is fixed", () => {
    setIndexStatus({ ok: false, reason: "dim 768 ≠ 1024" });
    expect(() => assertIndexUsable()).toThrow("Search refused: dim 768 ≠ 1024");
    setIndexStatus({ ok: true, reason: "" });
    expect(() => assertIndexUsable()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/index-guard.test.ts`
Expected: FAIL with `Cannot find module '../src/services/index-guard.js'`.

- [ ] **Step 3: Implement**

Create `src/services/index-guard.ts`:

```ts
// Guards against searching an index that was built by another stack or embedding model

import type { StackConfig } from "../config/llm-stacks.js";

export interface IndexMeta {
  stack: string;
  embeddingModel: string;
  dim: number;
}

export interface IndexCheck {
  ok: boolean;
  reason: string;
}

const REINDEX_HINT = "run scripts/reindex-stack.ts";

export function expectedIndexMeta(stack: StackConfig): IndexMeta {
  return { stack: stack.name, embeddingModel: stack.embeddingModel, dim: stack.embeddingDim };
}

export function checkIndexMeta(
  expected: IndexMeta,
  actual: IndexMeta | null,
  probeDim: number | null,
  label: string
): IndexCheck {
  if (probeDim !== null && probeDim !== expected.dim) {
    return { ok: false, reason: `${label}: embedding server returned ${probeDim} dimensions, expected ${expected.dim}` };
  }
  if (actual === null) {
    return { ok: false, reason: `${label}: index has no stack metadata — ${REINDEX_HINT}` };
  }

  const mismatches: string[] = [];
  if (actual.stack !== expected.stack) mismatches.push(`stack ${actual.stack} ≠ ${expected.stack}`);
  if (actual.embeddingModel !== expected.embeddingModel) {
    mismatches.push(`embedding model ${actual.embeddingModel} ≠ ${expected.embeddingModel}`);
  }
  if (actual.dim !== expected.dim) mismatches.push(`dim ${actual.dim} ≠ ${expected.dim}`);

  if (mismatches.length > 0) {
    return { ok: false, reason: `${label}: ${mismatches.join(", ")} — ${REINDEX_HINT}` };
  }
  return { ok: true, reason: "" };
}

export function indexMetaFromChroma(metadata: Record<string, unknown> | null | undefined): IndexMeta | null {
  if (!metadata) return null;
  const { stack, embedding_model: embeddingModel, dim } = metadata;
  if (typeof stack !== "string" || typeof embeddingModel !== "string" || typeof dim !== "number") return null;
  return { stack, embeddingModel, dim };
}

export function indexMetaToChroma(meta: IndexMeta): Record<string, string | number> {
  return { stack: meta.stack, embedding_model: meta.embeddingModel, dim: meta.dim };
}

// Runtime status, set at startup and after a reindex. Searches are refused until it is ok.
let status: IndexCheck = { ok: false, reason: "search index not verified yet" };

export function setIndexStatus(check: IndexCheck): void {
  status = check;
}

export function getIndexStatus(): IndexCheck {
  return status;
}

export function assertIndexUsable(): void {
  if (!status.ok) throw new Error(`Search refused: ${status.reason}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- __tests__/index-guard.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/services/index-guard.ts __tests__/index-guard.test.ts
git commit -m "feat: add search index compatibility guard

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Raw document store and news persistence

**Files:**
- Create: `src/services/raw-documents.ts`
- Modify: `src/api/knowledge.ts` (remove the local raw-document helpers), `src/services/news-agent.ts` (persist articles)
- Test: `__tests__/raw-documents.test.ts`

**Interfaces:**
- Produces:
  - `interface RawDocument { source: string; content: string; metadata: Record<string, unknown>; saved_at: string }`
  - `interface SaveOptions { key?: string; dir?: string }`
  - `const RAW_DOCUMENTS_DIR: string`
  - `rawDocumentFilename(key: string): string`
  - `saveRawDocument(source: string, content: string, metadata?: Record<string, unknown>, options?: SaveOptions): Promise<void>`
  - `listRawDocuments(dir?: string): Promise<RawDocument[]>`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/raw-documents.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRawDocuments, rawDocumentFilename, saveRawDocument } from "../src/services/raw-documents.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "raw-docs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveRawDocument", () => {
  it("names files after the source when no key is given, matching existing raw documents", async () => {
    await saveRawDocument("glp1-market", "GLP-1 text", { type: "text" }, { dir });
    expect(await readdir(dir)).toEqual([rawDocumentFilename("glp1-market")]);
  });

  it("keeps separate files for news articles that share a source name", async () => {
    await saveRawDocument("news-2026-09-16", "Article A", { type: "news" }, { dir, key: "https://a.example" });
    await saveRawDocument("news-2026-09-16", "Article B", { type: "news" }, { dir, key: "https://b.example" });
    expect((await readdir(dir)).length).toBe(2);
  });

  it("overwrites a document saved again with the same key", async () => {
    await saveRawDocument("news-2026-09-16", "old", {}, { dir, key: "https://a.example" });
    await saveRawDocument("news-2026-09-16", "new", {}, { dir, key: "https://a.example" });
    const docs = await listRawDocuments(dir);
    expect(docs.map((d) => d.content)).toEqual(["new"]);
  });
});

describe("listRawDocuments", () => {
  it("returns saved documents and skips unreadable files", async () => {
    await saveRawDocument("pfizer-overview", "Pfizer text", { type: "text" }, { dir });
    await writeFile(join(dir, "broken.json"), "{not json", "utf-8");
    await writeFile(join(dir, "notes.txt"), "ignored", "utf-8");

    const docs = await listRawDocuments(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: "pfizer-overview", content: "Pfizer text", metadata: { type: "text" } });
    expect(typeof docs[0].saved_at).toBe("string");
  });

  it("returns an empty list when the directory does not exist", async () => {
    await expect(listRawDocuments(join(dir, "missing"))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/raw-documents.test.ts`
Expected: FAIL with `Cannot find module '../src/services/raw-documents.js'`.

- [ ] **Step 3: Implement**

Create `src/services/raw-documents.ts`:

```ts
// Raw document store: the on-disk source of truth that per-stack indexes are rebuilt from

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RawDocument {
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  saved_at: string;
}

export interface SaveOptions {
  // Identity of the document; defaults to the source. News uses the article URL,
  // because every article from one day shares the same source name.
  key?: string;
  dir?: string;
}

export const RAW_DOCUMENTS_DIR = join(process.cwd(), "data", "raw_documents");

export function rawDocumentFilename(key: string): string {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`;
}

export async function saveRawDocument(
  source: string,
  content: string,
  metadata: Record<string, unknown> = {},
  options: SaveOptions = {}
): Promise<void> {
  const dir = options.dir ?? RAW_DOCUMENTS_DIR;
  await mkdir(dir, { recursive: true });
  const doc: RawDocument = { source, content, metadata, saved_at: new Date().toISOString() };
  await writeFile(join(dir, rawDocumentFilename(options.key ?? source)), JSON.stringify(doc), "utf-8");
}

function isRawDocument(value: unknown): value is RawDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  return typeof doc.source === "string" && typeof doc.content === "string";
}

export async function listRawDocuments(dir: string = RAW_DOCUMENTS_DIR): Promise<RawDocument[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const docs: RawDocument[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf-8")) as unknown;
      if (!isRawDocument(parsed)) throw new Error("missing source or content");
      docs.push({
        source: parsed.source,
        content: parsed.content,
        metadata: parsed.metadata ?? {},
        saved_at: parsed.saved_at ?? "",
      });
    } catch (err) {
      console.warn(`[Raw Documents] Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return docs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- __tests__/raw-documents.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use the shared store in `src/api/knowledge.ts`**

Delete the local `sourceHash` and `saveRawDocument` functions and the `RAW_DOCUMENTS_DIR` constant (currently lines 39–60, from `const KNOWLEDGE_DIR` through the end of `saveRawDocument`), and delete the now-unused `import { createHash } from "node:crypto";`. Keep `const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");`.

Add this import below the existing `../services/chromadb-store.js` import block:

```ts
import { RAW_DOCUMENTS_DIR, saveRawDocument } from "../services/raw-documents.js";
```

The two existing call sites (`saveRawDocument(url, cleaned, { type: "url" })` and `saveRawDocument(sourceName, text, { type: "text" })`) keep working unchanged: without a key, the filename is still derived from the source, so existing files in `data/raw_documents/` keep their names.

- [ ] **Step 6: Persist news articles in `src/services/news-agent.ts`**

Add the import below `import { addToChromaDB, isChromaDBAvailable } from "./chromadb-store.js";`:

```ts
import { saveRawDocument } from "./raw-documents.js";
```

In `runNewsAgent`, replace:

```ts
      // 1. In-memory store
      ingestText(text, sourceName);
```

with:

```ts
      // 1. Raw document: lets every stack's index be rebuilt from disk
      await saveRawDocument(
        sourceName,
        text,
        { type: "news", link: item.link, title: item.title },
        { key: item.link || text }
      );

      // 2. In-memory store (awaited so saveIndex below includes the embedding)
      await ingestText(text, sourceName);
```

and renumber the following comments `// 2. ChromaDB` → `// 3. ChromaDB` and `// 3. Neo4j graph extraction` → `// 4. Neo4j graph extraction`.

- [ ] **Step 7: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run test`
Expected: exit 0; all suites pass.

```bash
git add src/services/raw-documents.ts __tests__/raw-documents.test.ts src/api/knowledge.ts src/services/news-agent.ts
git commit -m "feat: persist news articles as raw documents for reindexing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Per-stack in-memory knowledge index

**Files:**
- Create: `src/utils/batches.ts`
- Modify: `src/services/knowledge-store.ts` (full rewrite below)
- Test: `__tests__/batches.test.ts`, `__tests__/knowledge-store.test.ts`

**Interfaces:**
- Consumes: `getActiveStack` (Task 2), `getLlmClient` (Task 3), `expectedIndexMeta`, `assertIndexUsable`, `IndexMeta` (Task 4).
- Produces:
  - `toBatches<T>(items: T[], size: number): T[][]` in `src/utils/batches.ts`
  - From `knowledge-store.ts`, unchanged: `searchKnowledge(query, topK?, precomputedEmbedding?: number[])`, `ingestFile`, `ingestText(text, sourceName)`, `saveIndex()`, `loadIndex()`, `ingestKnowledgeDir()`, `getStats()`, `type KnowledgeChunk`
  - New: `interface TextItem { text: string; source: string }`, `interface KnowledgeFile { name: string; path: string }`, `ingestTexts(items: TextItem[]): Promise<number>`, `listKnowledgeFiles(): Promise<KnowledgeFile[]>`, `resetIndex(): void`, `getIndexMeta(): IndexMeta | null`, `readIndexSummary(): Promise<{ meta: IndexMeta | null; chunkCount: number } | null>`, `encodeEmbedding(values: ArrayLike<number>): string`, `decodeEmbedding(encoded: string): Float32Array`, `parseIndexFile(raw: unknown): ParsedIndex`, `serializeIndex(meta: IndexMeta, items: KnowledgeChunk[]): string`
  - `KnowledgeChunk.embedding` becomes `Float32Array`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/batches.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { toBatches } from "../src/utils/batches.js";

describe("toBatches", () => {
  it("splits items into batches of the given size, keeping order", () => {
    expect(toBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no batches for an empty list", () => {
    expect(toBatches([], 3)).toEqual([]);
  });

  it("rejects a non-positive batch size", () => {
    expect(() => toBatches([1], 0)).toThrow("Batch size must be a positive integer");
  });
});
```

Create `__tests__/knowledge-store.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { decodeEmbedding, encodeEmbedding, parseIndexFile, serializeIndex } from "../src/services/knowledge-store.js";

const meta = { stack: "ollama", embeddingModel: "qwen3-embedding:0.6b-q8_0", dim: 3 };

describe("embedding encoding", () => {
  it("round-trips vectors through base64 Float32", () => {
    const decoded = decodeEmbedding(encodeEmbedding([0.25, -1.5, 3.125]));
    expect(Array.from(decoded)).toEqual([0.25, -1.5, 3.125]);
  });

  it("decodes small vectors whose Buffer comes from Node's shared pool", () => {
    // Small Buffers share a pool and can start at an offset that isn't a multiple of 4
    const decoded = decodeEmbedding(encodeEmbedding([0.1, 0.2, 0.3]));
    expect(decoded[0]).toBeCloseTo(0.1, 6);
    expect(decoded[2]).toBeCloseTo(0.3, 6);
  });
});

describe("index file format", () => {
  it("round-trips metadata and chunks", () => {
    const json = serializeIndex(meta, [
      { id: "a-0", source: "a.md", content: "hello", embedding: Float32Array.from([1, 0, 0]) },
    ]);
    const parsed = parseIndexFile(JSON.parse(json) as unknown);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({ id: "a-0", source: "a.md", content: "hello" });
    expect(Array.from(parsed.chunks[0].embedding)).toEqual([1, 0, 0]);
  });

  it("treats a legacy array index as having no metadata and no usable chunks", () => {
    const parsed = parseIndexFile([{ id: "x", source: "x", content: "x", embedding: [1, 2] }]);
    expect(parsed).toEqual({ meta: null, chunks: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/batches.test.ts __tests__/knowledge-store.test.ts`
Expected: FAIL (`Cannot find module '../src/utils/batches.js'`, and `encodeEmbedding` is not exported).

- [ ] **Step 3: Implement `toBatches`**

Create `src/utils/batches.ts`:

```ts
// Split a list into consecutive batches, e.g. for embedding or upsert requests

export function toBatches<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("Batch size must be a positive integer");
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
```

- [ ] **Step 4: Rewrite `src/services/knowledge-store.ts`**

Replace the whole file with:

```ts
// Knowledge store with vector embeddings for semantic search (RAG)
// Each LLM stack keeps its own index file, so vectors from different embedding models never mix.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getActiveStack } from "../config/llm-stacks.js";
import { getLlmClient } from "./llm-client.js";
import { assertIndexUsable, expectedIndexMeta } from "./index-guard.js";
import type { IndexMeta } from "./index-guard.js";
import { parseFile, isSupportedFile } from "./file-parser.js";
import { toBatches } from "../utils/batches.js";

interface KnowledgeChunk {
  id: string;
  source: string;
  content: string;
  embedding: Float32Array;
}

interface StoredChunk {
  id: string;
  source: string;
  content: string;
  embedding: string; // base64 Float32
}

interface IndexFile {
  version: 2;
  meta: IndexMeta | null;
  chunks: StoredChunk[];
}

export interface ParsedIndex {
  meta: IndexMeta | null;
  chunks: KnowledgeChunk[];
}

export interface TextItem {
  text: string;
  source: string;
}

export interface KnowledgeFile {
  name: string;
  path: string;
}

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");
const EMBED_BATCH_SIZE = 32;

let chunks: KnowledgeChunk[] = [];
let indexMeta: IndexMeta | null = null;

function indexPath(): string {
  return join(KNOWLEDGE_DIR, getActiveStack().indexFile);
}

// Split text into reasonably sized chunks
function chunkText(text: string, maxChunkSize: number = 800): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const result: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxChunkSize && current.length > 0) {
      result.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + trimmed;
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

// Cosine similarity between two vectors
function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// Keyword match score: fraction of query words found in content
function keywordScore(query: string, content: string): number {
  const contentLower = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const matches = words.filter((w) => contentLower.includes(w)).length;
  return matches / words.length;
}

// Embeddings are stored as base64 Float32 to keep the index file small and fast to parse
export function encodeEmbedding(values: ArrayLike<number>): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

export function decodeEmbedding(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  // Copy into a fresh buffer: pooled Buffers may start at an offset Float32Array can't use
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer);
}

export function parseIndexFile(raw: unknown): ParsedIndex {
  // Legacy indexes (plain arrays) predate the stack switch and can't be trusted
  if (Array.isArray(raw)) return { meta: null, chunks: [] };

  const file = raw as Partial<IndexFile>;
  if (file.version !== 2 || !Array.isArray(file.chunks)) return { meta: null, chunks: [] };

  return {
    meta: file.meta ?? null,
    chunks: file.chunks.map((c) => ({
      id: c.id,
      source: c.source,
      content: c.content,
      embedding: decodeEmbedding(c.embedding),
    })),
  };
}

export function serializeIndex(meta: IndexMeta, items: KnowledgeChunk[]): string {
  const file: IndexFile = {
    version: 2,
    meta,
    chunks: items.map((c) => ({
      id: c.id,
      source: c.source,
      content: c.content,
      embedding: encodeEmbedding(c.embedding),
    })),
  };
  return JSON.stringify(file);
}

// Hybrid search: vector similarity + keyword boost
// Accepts an optional pre-computed embedding to avoid a redundant embedding call.
export async function searchKnowledge(query: string, topK: number = 5, precomputedEmbedding?: number[]): Promise<KnowledgeChunk[]> {
  assertIndexUsable();
  if (chunks.length === 0) return [];

  const queryEmbedding = precomputedEmbedding ?? await getLlmClient().embed(query, "query");

  const scored = chunks
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const kwScore = keywordScore(query, chunk.content);
      // Hybrid: 70% vector + 30% keyword
      const combined = vectorScore * 0.7 + kwScore * 0.3;
      return { chunk, score: combined };
    })
    .filter((item) => item.score > 0.2)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by content prefix
  const seen = new Set<string>();
  const results: KnowledgeChunk[] = [];
  for (const item of scored) {
    const key = item.chunk.content.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item.chunk);
    if (results.length >= topK) break;
  }

  return results;
}

// Ingest a file (any supported format) into the knowledge base
export async function ingestFile(filePath: string, sourceName: string): Promise<number> {
  const content = await parseFile(filePath);
  return ingestText(content, sourceName);
}

// Ingest several texts, embedding their chunks in batches
export async function ingestTexts(items: TextItem[]): Promise<number> {
  const pending = items.flatMap((item) =>
    chunkText(item.text).map((content) => ({ source: item.source, content }))
  );
  const client = getLlmClient();

  for (const batch of toBatches(pending, EMBED_BATCH_SIZE)) {
    const embeddings = await client.embedMany(batch.map((p) => p.content), "document");
    batch.forEach((p, i) => {
      chunks.push({
        id: `${p.source}-${chunks.length}`,
        source: p.source,
        content: p.content,
        embedding: Float32Array.from(embeddings[i]),
      });
    });
  }

  return pending.length;
}

// Ingest raw text into the knowledge base
export async function ingestText(text: string, sourceName: string): Promise<number> {
  return ingestTexts([{ text, source: sourceName }]);
}

// Start an empty index for the active stack
export function resetIndex(): void {
  chunks = [];
  indexMeta = expectedIndexMeta(getActiveStack());
}

export function getIndexMeta(): IndexMeta | null {
  return indexMeta;
}

// Save the index to disk
export async function saveIndex(): Promise<void> {
  if (indexMeta === null) {
    throw new Error("Refusing to save an index without stack metadata — run scripts/reindex-stack.ts");
  }
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  await writeFile(indexPath(), serializeIndex(indexMeta, chunks), "utf-8");
}

// Load the active stack's index from disk
export async function loadIndex(): Promise<void> {
  const path = indexPath();
  let data: string;
  try {
    data = await readFile(path, "utf-8");
  } catch {
    resetIndex();
    console.log(`No index at ${path}, starting empty`);
    return;
  }

  const parsed = parseIndexFile(JSON.parse(data) as unknown);
  chunks = parsed.chunks;
  indexMeta = parsed.meta;
  console.log(`Index loaded: ${chunks.length} chunks (${path})`);
}

// Read the index file's metadata and size without decoding embeddings
export async function readIndexSummary(): Promise<{ meta: IndexMeta | null; chunkCount: number } | null> {
  try {
    const raw = JSON.parse(await readFile(indexPath(), "utf-8")) as unknown;
    if (Array.isArray(raw)) return { meta: null, chunkCount: raw.length };
    const file = raw as Partial<IndexFile>;
    return {
      meta: file.version === 2 ? file.meta ?? null : null,
      chunkCount: Array.isArray(file.chunks) ? file.chunks.length : 0,
    };
  } catch {
    return null;
  }
}

// Supported files in knowledge/, skipping dotfiles such as the index files
export async function listKnowledgeFiles(): Promise<KnowledgeFile[]> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  const files = await readdir(KNOWLEDGE_DIR);
  return files
    .filter((file) => !file.startsWith(".") && isSupportedFile(file))
    .sort()
    .map((name) => ({ name, path: join(KNOWLEDGE_DIR, name) }));
}

// Ingest supported files from knowledge/ that aren't indexed yet
export async function ingestKnowledgeDir(): Promise<number> {
  let total = 0;
  const indexedSources = new Set(chunks.map((c) => c.source));

  try {
    for (const file of await listKnowledgeFiles()) {
      if (indexedSources.has(file.name)) {
        console.log(`  Skipped: ${file.name} (already indexed)`);
        continue;
      }
      const added = await ingestFile(file.path, file.name);
      total += added;
      console.log(`  Ingested: ${file.name} (${added} chunks)`);
    }
  } catch (err) {
    console.log(`knowledge/ ingestion stopped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return total;
}

// Return knowledge base stats
export function getStats(): { totalChunks: number; sources: string[] } {
  const sources = [...new Set(chunks.map((c) => c.source))];
  return { totalChunks: chunks.length, sources };
}

export type { KnowledgeChunk };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- __tests__/batches.test.ts __tests__/knowledge-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run test`
Expected: exit 0; all suites pass. (`chat.ts` still passes `number[]` embeddings and reads only `source`/`content` from chunks, so it compiles unchanged.)

```bash
git add src/utils/batches.ts src/services/knowledge-store.ts __tests__/batches.test.ts __tests__/knowledge-store.test.ts
git commit -m "feat: store the in-memory index per stack with metadata and compact embeddings

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Per-stack ChromaDB collection

**Files:**
- Modify: `src/services/chromadb-store.ts` (full rewrite below)
- Test: `__tests__/chromadb-store.test.ts`

**Interfaces:**
- Consumes: `getActiveStack` (Task 2), `getLlmClient` (Task 3), `expectedIndexMeta`, `indexMetaFromChroma`, `indexMetaToChroma`, `assertIndexUsable`, `IndexMeta` (Task 4), `toBatches` (Task 6).
- Produces:
  - Unchanged exports: `searchChromaDB(query, topK?, precomputedEmbedding?)`, `addToChromaDB(texts, metadatas)`, `chromaDocumentExists(source)`, `getChromaStatus()`, `isChromaDBAvailable()`, `deleteChromaCollection()`, `recreateChromaCollection()`, `type ChromaQueryResult`
  - New: `interface ChromaEntry { id: string; document: string; metadata: Record<string, unknown> }`, `interface ChromaCollectionInfo { meta: IndexMeta | null; count: number }`, `dedupeEntries(entries: ChromaEntry[]): ChromaEntry[]`, `getChromaCollectionInfo(): Promise<ChromaCollectionInfo | null>` (never creates a collection)

- [ ] **Step 1: Write the failing test**

Create `__tests__/chromadb-store.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { dedupeEntries } from "../src/services/chromadb-store.js";

describe("dedupeEntries", () => {
  it("keeps the first entry for each ID, because Chroma rejects duplicate IDs in one upsert", () => {
    const entries = [
      { id: "a", document: "first", metadata: { source: "news-1" } },
      { id: "b", document: "other", metadata: { source: "news-1" } },
      { id: "a", document: "second", metadata: { source: "news-2" } },
    ];
    expect(dedupeEntries(entries).map((e) => e.document)).toEqual(["first", "other"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- __tests__/chromadb-store.test.ts`
Expected: FAIL with `dedupeEntries is not a function` (or a missing-export type error).

- [ ] **Step 3: Rewrite `src/services/chromadb-store.ts`**

Replace the whole file with:

```ts
// ChromaDB vector store client for RAG
// Connects to a running ChromaDB server via its REST API. Each LLM stack uses its own collection.

import { getActiveStack } from "../config/llm-stacks.js";
import { getLlmClient } from "./llm-client.js";
import { assertIndexUsable, expectedIndexMeta, indexMetaFromChroma, indexMetaToChroma } from "./index-guard.js";
import type { IndexMeta } from "./index-guard.js";
import { toBatches } from "../utils/batches.js";

const CHROMADB_URL = process.env.CHROMADB_URL ?? "http://localhost:8100";
const TENANT = "default_tenant";
const DATABASE = "default_database";
const EMBED_BATCH_SIZE = 32;
const UPSERT_BATCH_SIZE = 500;

const BASE = `${CHROMADB_URL}/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`;

interface ChromaCollection {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

interface ChromaQueryResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

export interface ChromaEntry {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
}

export interface ChromaCollectionInfo {
  meta: IndexMeta | null;
  count: number;
}

// Cached collection ID, keyed by name so a different stack never reuses it
let cachedCollection: { name: string; id: string } | null = null;

function collectionName(): string {
  return getActiveStack().chromaCollection;
}

async function findCollection(): Promise<ChromaCollection | null> {
  const resp = await fetch(BASE);
  if (!resp.ok) {
    throw new Error(`ChromaDB: failed to list collections (${resp.status})`);
  }
  const collections = (await resp.json()) as ChromaCollection[];
  return collections.find((c) => c.name === collectionName()) ?? null;
}

// Resolve the active stack's collection ID, creating the collection with index metadata if needed
async function getCollectionId(): Promise<string> {
  const name = collectionName();
  if (cachedCollection?.name === name) return cachedCollection.id;

  const existing = await findCollection();
  if (existing) {
    cachedCollection = { name, id: existing.id };
    return existing.id;
  }

  const createResp = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      metadata: {
        "hnsw:space": "cosine",
        ...indexMetaToChroma(expectedIndexMeta(getActiveStack())),
      },
    }),
  });
  if (!createResp.ok) {
    throw new Error(`ChromaDB: failed to create collection (${createResp.status})`);
  }
  const created = (await createResp.json()) as ChromaCollection;
  cachedCollection = { name, id: created.id };
  return created.id;
}

// Split text into chunks of roughly ~500 tokens (≈ 2000 chars)
function chunkText(text: string, charLimit: number = 2000): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 > charLimit && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    // Split oversized paragraphs on sentence boundaries
    if (trimmed.length > charLimit) {
      const sentences = trimmed.split(/(?<=\.)\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 > charLimit && current.length > 0) {
          chunks.push(current.trim());
          current = "";
        }
        current += (current ? " " : "") + sentence;
      }
    } else {
      current += (current ? "\n\n" : "") + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// Generate a short deterministic ID from text
function makeId(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(8, "0");
}

// Chroma rejects duplicate IDs inside one upsert, and identical chunks hash to the same ID
export function dedupeEntries(entries: ChromaEntry[]): ChromaEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/**
 * Query ChromaDB for the most relevant chunks.
 * Accepts an optional pre-computed embedding to avoid a redundant embedding call.
 */
export async function searchChromaDB(
  query: string,
  topK: number = 5,
  precomputedEmbedding?: number[]
): Promise<ChromaQueryResult[]> {
  assertIndexUsable();
  const id = await getCollectionId();
  const queryEmbedding = precomputedEmbedding ?? await getLlmClient().embed(query, "query");

  const resp = await fetch(`${BASE}/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query_embeddings: [queryEmbedding],
      n_results: topK,
      include: ["documents", "metadatas", "distances"],
    }),
  });

  if (!resp.ok) {
    throw new Error(`ChromaDB query failed (${resp.status})`);
  }

  const data = (await resp.json()) as {
    ids: string[][];
    documents: string[][];
    metadatas: Record<string, unknown>[][];
    distances: number[][];
  };

  if (!data.ids[0] || data.ids[0].length === 0) return [];

  const results: ChromaQueryResult[] = [];
  for (let i = 0; i < data.ids[0].length; i++) {
    results.push({
      id: data.ids[0][i],
      document: data.documents[0][i],
      metadata: data.metadatas[0][i],
      distance: data.distances[0][i],
    });
  }

  return results;
}

/**
 * Chunk texts, embed them on the active stack in batches, and upsert into ChromaDB.
 */
export async function addToChromaDB(
  texts: string[],
  metadatas: Record<string, unknown>[]
): Promise<number> {
  const id = await getCollectionId();
  const addedAt = new Date().toISOString();

  const entries: ChromaEntry[] = [];
  texts.forEach((text, t) => {
    const chunks = chunkText(text);
    chunks.forEach((chunk, i) => {
      entries.push({
        id: makeId(chunk),
        document: chunk,
        metadata: { ...metadatas[t], chunk_index: i, total_chunks: chunks.length, added_at: addedAt },
      });
    });
  });

  const unique = dedupeEntries(entries);
  if (unique.length === 0) return 0;

  const client = getLlmClient();
  const embeddings: number[][] = [];
  for (const batch of toBatches(unique, EMBED_BATCH_SIZE)) {
    embeddings.push(...(await client.embedMany(batch.map((e) => e.document), "document")));
  }

  let offset = 0;
  for (const batch of toBatches(unique, UPSERT_BATCH_SIZE)) {
    const resp = await fetch(`${BASE}/${id}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: batch.map((e) => e.id),
        documents: batch.map((e) => e.document),
        embeddings: embeddings.slice(offset, offset + batch.length),
        metadatas: batch.map((e) => e.metadata),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ChromaDB upsert failed (${resp.status}): ${body}`);
    }
    offset += batch.length;
  }

  return unique.length;
}

/**
 * Check if a source URL already has chunks in ChromaDB.
 */
export async function chromaDocumentExists(source: string): Promise<boolean> {
  const id = await getCollectionId();

  const resp = await fetch(`${BASE}/${id}/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      where: { source },
      limit: 1,
      include: [],
    }),
  });

  if (!resp.ok) return false;

  const data = (await resp.json()) as { ids: string[] };
  return data.ids.length > 0;
}

/**
 * Metadata and size of the active stack's collection, or null if it doesn't exist.
 * Unlike the other functions, this never creates the collection.
 */
export async function getChromaCollectionInfo(): Promise<ChromaCollectionInfo | null> {
  const collection = await findCollection();
  if (!collection) return null;

  const countResp = await fetch(`${BASE}/${collection.id}/count`);
  const count = countResp.ok ? ((await countResp.json()) as number) : 0;
  return { meta: indexMetaFromChroma(collection.metadata), count };
}

/**
 * Return stats about the ChromaDB knowledge base.
 */
export async function getChromaStatus(): Promise<{
  totalChunks: number;
  sources: string[];
  lastAdded: string | null;
}> {
  const id = await getCollectionId();

  // Get count
  const countResp = await fetch(`${BASE}/${id}/count`, { method: "GET" });
  const totalChunks = countResp.ok ? ((await countResp.json()) as number) : 0;

  // Get all metadatas to extract sources and timestamps
  let sources: string[] = [];
  let lastAdded: string | null = null;

  if (totalChunks > 0) {
    const getResp = await fetch(`${BASE}/${id}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include: ["metadatas"] }),
    });

    if (getResp.ok) {
      const data = (await getResp.json()) as { metadatas: Record<string, unknown>[] };
      const sourceSet = new Set<string>();

      for (const meta of data.metadatas) {
        if (typeof meta.source === "string") sourceSet.add(meta.source);
        if (typeof meta.added_at === "string") {
          if (!lastAdded || meta.added_at > lastAdded) {
            lastAdded = meta.added_at;
          }
        }
      }
      sources = [...sourceSet].sort();
    }
  }

  return { totalChunks, sources, lastAdded };
}

/**
 * Check if the ChromaDB server is reachable.
 */
export async function isChromaDBAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${CHROMADB_URL}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Delete the active stack's collection and reset the cached ID.
 */
export async function deleteChromaCollection(): Promise<void> {
  cachedCollection = null;
  const existing = await findCollection();
  if (!existing) return;

  const resp = await fetch(`${BASE}/${existing.id}`, { method: "DELETE" });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`ChromaDB: failed to delete collection (${resp.status})`);
  }
}

/**
 * Delete and recreate the active stack's collection (empty, with index metadata).
 */
export async function recreateChromaCollection(): Promise<void> {
  await deleteChromaCollection();
  await getCollectionId();
}

export type { ChromaQueryResult };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- __tests__/chromadb-store.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Check the collection DELETE route against the running ChromaDB**

The old code deleted by ID; confirm the v2 API accepts it on a throwaway collection:

```bash
C=http://localhost:8100/api/v2/tenants/default_tenant/databases/default_database/collections
ID=$(curl -s -XPOST $C -H 'Content-Type: application/json' -d '{"name":"plan_probe","metadata":{"stack":"x","embedding_model":"y","dim":3}}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["id"], d.get("metadata"))')
echo "$ID"
curl -s $C | python3 -c 'import sys,json;print([c.get("metadata") for c in json.load(sys.stdin) if c["name"]=="plan_probe"])'
curl -s -o /dev/null -w "delete by id: %{http_code}\n" -XDELETE "$C/${ID%% *}"
curl -s -o /dev/null -w "delete by name: %{http_code}\n" -XDELETE "$C/plan_probe"
```

Expected: the listed metadata contains `stack`, `embedding_model` and `dim`; one of the two DELETE calls returns `200`. If only **delete by name** returns 200, change `deleteChromaCollection` to call `` `${BASE}/${encodeURIComponent(existing.name)}` `` instead of `existing.id`, and note it in the commit message.

- [ ] **Step 6: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run test`
Expected: exit 0; all suites pass.

```bash
git add src/services/chromadb-store.ts __tests__/chromadb-store.test.ts
git commit -m "feat: use a per-stack ChromaDB collection with index metadata and batched upserts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Benchmark mode and job tracking

**Files:**
- Create: `src/services/bench-mode.ts`, `src/api/bench.ts`
- Modify: `src/server.ts` (mount the router)
- Test: `__tests__/bench-mode.test.ts`

**Interfaces:**
- Produces:
  - `interface ChatTimings { embedMs: number; retrievalMs: number; ttftMs: number; decodeTokPerSec: number; promptTokens: number; completionTokens: number; totalMs: number }`
  - `setBenchmarkActive(active: boolean): void`, `isBenchmarkActive(): boolean`
  - `markJobStarted(name: string): void`, `markJobFinished(name: string): void`, `getRunningJobs(): string[]`
  - `trackJob<T>(name: string, job: () => Promise<T>): Promise<T>`
  - Routes: `POST /api/bench/start`, `POST /api/bench/stop`, `GET /api/bench/status`, each returning `{ active: boolean, runningJobs: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/bench-mode.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  getRunningJobs,
  isBenchmarkActive,
  markJobFinished,
  markJobStarted,
  setBenchmarkActive,
  trackJob,
} from "../src/services/bench-mode.js";

afterEach(() => {
  setBenchmarkActive(false);
});

describe("benchmark flag", () => {
  it("toggles benchmark mode", () => {
    expect(isBenchmarkActive()).toBe(false);
    setBenchmarkActive(true);
    expect(isBenchmarkActive()).toBe(true);
  });
});

describe("job tracking", () => {
  it("reports a job while it runs and clears it afterwards", async () => {
    let seenDuringRun: string[] = [];
    await trackJob("news-agent", async () => {
      seenDuringRun = getRunningJobs();
    });
    expect(seenDuringRun).toEqual(["news-agent"]);
    expect(getRunningJobs()).toEqual([]);
  });

  it("clears a job that throws", async () => {
    await expect(trackJob("gap-detection", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(getRunningJobs()).toEqual([]);
  });

  it("counts overlapping runs of the same job", () => {
    markJobStarted("graph-extraction");
    markJobStarted("graph-extraction");
    markJobFinished("graph-extraction");
    expect(getRunningJobs()).toEqual(["graph-extraction"]);
    markJobFinished("graph-extraction");
    expect(getRunningJobs()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/bench-mode.test.ts`
Expected: FAIL with `Cannot find module '../src/services/bench-mode.js'`.

- [ ] **Step 3: Implement the module**

Create `src/services/bench-mode.ts`:

```ts
// Benchmark mode: while active, background LLM jobs skip their runs so benchmarks get the GPU to themselves

export interface ChatTimings {
  embedMs: number;
  retrievalMs: number;
  ttftMs: number;
  decodeTokPerSec: number;
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
}

let benchmarkActive = false;

// Count per job name so overlapping runs of the same job are tracked correctly
const runningJobs = new Map<string, number>();

export function setBenchmarkActive(active: boolean): void {
  benchmarkActive = active;
}

export function isBenchmarkActive(): boolean {
  return benchmarkActive;
}

export function markJobStarted(name: string): void {
  runningJobs.set(name, (runningJobs.get(name) ?? 0) + 1);
}

export function markJobFinished(name: string): void {
  const remaining = (runningJobs.get(name) ?? 0) - 1;
  if (remaining > 0) {
    runningJobs.set(name, remaining);
  } else {
    runningJobs.delete(name);
  }
}

export function getRunningJobs(): string[] {
  return [...runningJobs.keys()].sort();
}

export async function trackJob<T>(name: string, job: () => Promise<T>): Promise<T> {
  markJobStarted(name);
  try {
    return await job();
  } finally {
    markJobFinished(name);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- __tests__/bench-mode.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the routes**

Create `src/api/bench.ts`:

```ts
// Routes for benchmark mode

import { Router } from "express";
import type { Request, Response } from "express";
import { getRunningJobs, isBenchmarkActive, setBenchmarkActive } from "../services/bench-mode.js";

const router = Router();

function benchStatus(): { active: boolean; runningJobs: string[] } {
  return { active: isBenchmarkActive(), runningJobs: getRunningJobs() };
}

// POST /api/bench/start - Pause background LLM jobs
router.post("/start", (_req: Request, res: Response): void => {
  setBenchmarkActive(true);
  res.json(benchStatus());
});

// POST /api/bench/stop - Resume background LLM jobs
router.post("/stop", (_req: Request, res: Response): void => {
  setBenchmarkActive(false);
  res.json(benchStatus());
});

// GET /api/bench/status - Benchmark flag and jobs still running
router.get("/status", (_req: Request, res: Response): void => {
  res.json(benchStatus());
});

export default router;
```

In `src/server.ts`, add below `import graphRouter from "./api/graph.js";`:

```ts
import benchRouter from "./api/bench.js";
```

and below `app.use("/api/graph", graphRouter);`:

```ts
app.use("/api/bench", benchRouter);
```

- [ ] **Step 6: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run test`
Expected: exit 0; all suites pass.

```bash
git add src/services/bench-mode.ts src/api/bench.ts src/server.ts __tests__/bench-mode.test.ts
git commit -m "feat: add benchmark mode with background job tracking

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Move all call sites to the LLM client

Wires the app to the active stack, adds benchmark behavior and per-phase timings to chat, verifies indexes at startup, and deletes `src/services/ollama.ts`.

**Files:**
- Modify: `src/api/chat.ts`, `src/api/knowledge.ts`, `src/services/gap-detector.ts`, `src/services/news-agent.ts`, `src/server.ts`
- Delete: `src/services/ollama.ts`

**Interfaces:**
- Consumes: `getLlmClient`, `ChatMessage`, `StatsCollector` (Task 3); `getIndexStatus`, `setIndexStatus`, `checkIndexMeta`, `expectedIndexMeta`, `IndexCheck` (Task 4); `getIndexMeta` (Task 6); `getChromaCollectionInfo` (Task 7); `ChatTimings`, `isBenchmarkActive`, `trackJob` (Task 8).
- Produces:
  - `POST /api/chat` accepts `benchmark?: boolean`. The final SSE event is `{ done: true, response_id, stack, tokenStats, timings: ChatTimings, chunkIds?: string[] }` (`chunkIds` only in benchmark mode).
  - `GET /api/chat/models` returns `{ stack, chatModel, embeddingModel, models: string[] }` (503 with `error` when the stack is down).

- [ ] **Step 1: Update `src/services/gap-detector.ts`**

Replace:

```ts
import { chatWithOllama } from "./ollama.js";
import type { OllamaMessage } from "./ollama.js";
```

with:

```ts
import { getLlmClient } from "./llm-client.js";
import type { ChatMessage } from "./llm-client.js";
import { isBenchmarkActive, trackJob } from "./bench-mode.js";
```

Replace the comment `// Secondary call to Ollama to evaluate response confidence` with `// Secondary LLM call to evaluate response confidence`.

In `checkConfidence`, replace:

```ts
    const messages: OllamaMessage[] = [
      { role: "user", content: prompt },
    ];
    const response = await chatWithOllama(messages, model, { temperature: 0.1 });
```

with:

```ts
    const messages: ChatMessage[] = [
      { role: "user", content: prompt },
    ];
    const response = await getLlmClient().chat(messages, { model, temperature: 0.1 });
```

Replace the comment `// Guard: only one gap detection at a time so we don't hog Ollama` with `// Guard: only one gap detection at a time so we don't hog the LLM stack`.

In `handleGapDetection`, insert as the first statement of the function body:

```ts
  // Benchmarks need the GPU to themselves
  if (isBenchmarkActive()) return false;
```

and replace:

```ts
    const result = await checkConfidence(originalQuery, gemmaResponse, model);
```

with:

```ts
    const result = await trackJob("gap-detection", () => checkConfidence(originalQuery, gemmaResponse, model));
```

- [ ] **Step 2: Update `src/api/knowledge.ts`**

Replace:

```ts
import { chatWithOllama } from "../services/ollama.js";
import type { OllamaMessage } from "../services/ollama.js";
```

with:

```ts
import { getLlmClient } from "../services/llm-client.js";
import type { ChatMessage } from "../services/llm-client.js";
import { trackJob } from "../services/bench-mode.js";
```

In `extractAndWriteEntities`, replace:

```ts
    const response = await chatWithOllama(
      [
        { role: "system", content: extractionPrompt },
        { role: "user", content: text.slice(0, 12000) },
      ],
      undefined,
      { temperature: 0.1 }
    );
```

with:

```ts
    const response = await trackJob("graph-extraction", () =>
      getLlmClient().chat(
        [
          { role: "system", content: extractionPrompt },
          { role: "user", content: text.slice(0, 12000) },
        ],
        { temperature: 0.1 }
      )
    );
```

Replace the `/search` route:

```ts
  const results = await searchKnowledge(query, topK ?? 5);
  res.json({ results });
```

with:

```ts
  try {
    const results = await searchKnowledge(query, topK ?? 5);
    res.json({ results });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
```

In `/gaps/check-resolution`, replace:

```ts
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: original_query },
    ];

    const newResponse = await chatWithOllama(messages);

    // Run confidence check on the new response
    const confidence = await checkConfidence(original_query, newResponse);
```

with:

```ts
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: original_query },
    ];

    const newResponse = await trackJob("gap-resolution", () => getLlmClient().chat(messages));

    // Run confidence check on the new response
    const confidence = await trackJob("gap-resolution", () => checkConfidence(original_query, newResponse));
```

- [ ] **Step 3: Update `src/services/news-agent.ts`**

Replace `import { chatWithOllama } from "./ollama.js";` with:

```ts
import { getLlmClient } from "./llm-client.js";
import { getIndexStatus } from "./index-guard.js";
import { isBenchmarkActive, trackJob } from "./bench-mode.js";
```

In `extractNewsEntities`, replace:

```ts
    const response = await chatWithOllama(
      [
        { role: "system", content: extractionPrompt },
        { role: "user", content: combined },
      ],
      undefined,
      { temperature: 0.1 }
    );
```

with:

```ts
    const response = await trackJob("graph-extraction", () =>
      getLlmClient().chat(
        [
          { role: "system", content: extractionPrompt },
          { role: "user", content: combined },
        ],
        { temperature: 0.1 }
      )
    );
```

Rename the existing `export async function runNewsAgent(): Promise<{ newArticles: number; topics: number }> {` to `async function runNewsScrub(): Promise<{ newArticles: number; topics: number }> {` (body unchanged), and add directly above it:

```ts
export async function runNewsAgent(): Promise<{ newArticles: number; topics: number }> {
  const skipped = { newArticles: 0, topics: 0 };

  if (isBenchmarkActive()) {
    console.log("[News Agent] Skipped — benchmark mode is active");
    return skipped;
  }
  const indexStatus = getIndexStatus();
  if (!indexStatus.ok) {
    console.warn(`[News Agent] Skipped — ${indexStatus.reason}`);
    return skipped;
  }
  const llm = getLlmClient();
  if (!(await llm.isReachable())) {
    console.warn(`[News Agent] Skipped — the ${llm.stack.name} stack is not reachable`);
    return skipped;
  }

  return trackJob("news-agent", runNewsScrub);
}

```

- [ ] **Step 4: Update `src/api/chat.ts`**

Replace the imports:

```ts
import { streamChatWithOllama, listModels, getEmbedding } from "../services/ollama.js";
import type { OllamaMessage, TokenStats } from "../services/ollama.js";
```

with:

```ts
import { getLlmClient } from "../services/llm-client.js";
import type { ChatMessage, StatsCollector } from "../services/llm-client.js";
import { getIndexStatus } from "../services/index-guard.js";
import type { ChatTimings } from "../services/bench-mode.js";
```

Replace the request body destructuring:

```ts
  const { message, history, model, webSearch } = req.body as {
    message: string;
    history?: OllamaMessage[];
    model?: string;
    webSearch?: boolean;
  };
```

with:

```ts
  const { message, history, model, webSearch, benchmark } = req.body as {
    message: string;
    history?: ChatMessage[];
    model?: string;
    webSearch?: boolean;
    benchmark?: boolean;
  };
```

Replace `  const requestStart = Date.now();` (directly after the `/names` block) with:

```ts
  const llm = getLlmClient();
  const chatModel = model ?? llm.stack.chatModel;

  // Refuse early when the index was built by another stack or embedding model
  const indexStatus = getIndexStatus();
  if (!indexStatus.ok) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`data: ${JSON.stringify({ error: `Search index unusable on the ${llm.stack.name} stack: ${indexStatus.reason}` })}\n\n`);
    res.end();
    return;
  }

  const requestStart = Date.now();
```

Replace Step 1 of the RAG pipeline:

```ts
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await getEmbedding(message);
  } catch (err) {
```

with:

```ts
  let queryEmbedding: number[] | undefined;
  const embedStart = Date.now();
  try {
    queryEmbedding = await llm.embed(message, "query");
  } catch (err) {
```

and directly after that `try/catch` block (before `// Step 2: Fan out ALL searches in parallel`) add:

```ts
  const embedMs = Date.now() - embedStart;
  const retrievalStart = Date.now();
```

Replace the in-memory promise:

```ts
  const inmemoryPromise = (async () => {
    // Always compute in-memory results in parallel — use them only if ChromaDB misses
    return searchKnowledge(message, 8, queryEmbedding);
  })();
```

with:

```ts
  const inmemoryPromise = (async () => {
    // Always compute in-memory results in parallel — use them only if ChromaDB misses
    try {
      return await searchKnowledge(message, 8, queryEmbedding);
    } catch (err) {
      console.error("[RAG] In-memory search failed:", err instanceof Error ? err.message : err);
      return [];
    }
  })();
```

In `webSearchPromise`, replace `    if (webSearch === false) return "";` with:

```ts
    // Benchmarks skip web search: live results would differ between runs
    if (webSearch === false || benchmark) return "";
```

Directly after the `Promise.all([...])` destructuring statement, add:

```ts
  const retrievalMs = Date.now() - retrievalStart;
```

Replace:

```ts
  sendReasoning(`Generating response with ${model ?? "mistral-small:24b"}...`);

  const messages: OllamaMessage[] = [
```

with:

```ts
  sendReasoning(`Generating response with ${chatModel} on ${llm.stack.name.toUpperCase()}...`);

  const messages: ChatMessage[] = [
```

Replace the section from `    // Collect the full response during streaming` through `    res.end();` (the first `res.end()` after the `done` event) with:

```ts
    // Collect the full response during streaming
    let fullResponse = "";
    const statsCollector: StatsCollector = {};

    for await (const token of llm.streamChat(
      messages,
      { model: chatModel, temperature: benchmark ? 0 : undefined },
      statsCollector
    )) {
      fullResponse += token;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    // Store response metadata and generate response_id for feedback
    const responseId = createResponseEntry(
      message,
      fullResponse,
      chunkIds,
      hadRagContext,
      chatModel
    );

    const responseTimeMs = Date.now() - requestStart;
    const stats = statsCollector.result;
    const timings: ChatTimings = {
      embedMs,
      retrievalMs,
      ttftMs: stats?.ttftMs ?? 0,
      decodeTokPerSec: stats?.tokensPerSecond ?? 0,
      promptTokens: stats?.promptTokens ?? 0,
      completionTokens: stats?.completionTokens ?? 0,
      totalMs: responseTimeMs,
    };

    // Send done IMMEDIATELY — don't wait for gap detection
    res.write(`data: ${JSON.stringify({
      done: true,
      response_id: responseId,
      stack: llm.stack.name,
      tokenStats: stats ?? null,
      timings,
      ...(benchmark ? { chunkIds } : {}),
    })}\n\n`);
    res.end();

    // Benchmark runs skip gap detection and request logging: no background GPU work, no dashboard noise
    if (benchmark) return;
```

Replace the models route:

```ts
// GET /api/chat/models - List available Ollama models
router.get("/models", async (_req: Request, res: Response): Promise<void> => {
  try {
    const models = await listModels();
    res.json({ models });
  } catch {
    res.status(503).json({
      error: "Cannot reach Ollama. Make sure it is running.",
      models: [],
    });
  }
});
```

with:

```ts
// GET /api/chat/models - List models on the active LLM stack
router.get("/models", async (_req: Request, res: Response): Promise<void> => {
  const llm = getLlmClient();
  const stackInfo = {
    stack: llm.stack.name,
    chatModel: llm.stack.chatModel,
    embeddingModel: llm.stack.embeddingModel,
  };
  try {
    const models = await llm.listModels();
    res.json({ ...stackInfo, models });
  } catch (err) {
    res.status(503).json({
      ...stackInfo,
      error: err instanceof Error ? err.message : "LLM stack unavailable",
      models: [],
    });
  }
});
```

- [ ] **Step 5: Verify indexes at startup in `src/server.ts`**

Replace:

```ts
import { loadIndex, ingestKnowledgeDir, saveIndex } from "./services/knowledge-store.js";
import { isChromaDBAvailable, getChromaStatus } from "./services/chromadb-store.js";
```

with:

```ts
import { loadIndex, ingestKnowledgeDir, saveIndex, getIndexMeta } from "./services/knowledge-store.js";
import { isChromaDBAvailable, getChromaStatus, getChromaCollectionInfo } from "./services/chromadb-store.js";
import { getActiveStack } from "./config/llm-stacks.js";
import { getLlmClient } from "./services/llm-client.js";
import { checkIndexMeta, expectedIndexMeta, setIndexStatus } from "./services/index-guard.js";
import type { IndexCheck } from "./services/index-guard.js";
```

Add this function above `async function start(): Promise<void> {`:

```ts
// Check that both search indexes were built by the active stack's embedding model
async function verifyIndexes(chromaOk: boolean): Promise<IndexCheck> {
  const expected = expectedIndexMeta(getActiveStack());
  const probe = await getLlmClient()
    .embed("index compatibility probe", "document")
    .catch((err: unknown) => {
      console.warn(`Embedding probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  const probeDim = probe?.length ?? null;

  const memoryCheck = checkIndexMeta(expected, getIndexMeta(), probeDim, "in-memory index");
  if (!memoryCheck.ok || !chromaOk) return memoryCheck;

  const info = await getChromaCollectionInfo();
  // A missing collection is created with the right metadata on first write
  if (!info) return { ok: true, reason: "" };
  return checkIndexMeta(expected, info.meta, probeDim, "ChromaDB collection");
}

```

In `start()`, replace everything from `  initGapDB();` through the end of the ChromaDB availability `if/else` block:

```ts
  initGapDB();
  initFeedbackDB();
  initRequestLog();
  await loadIndex();

  const added = await ingestKnowledgeDir();
  if (added > 0) {
    await saveIndex();
    console.log(`${added} new chunks ingested from files`);
  }

  // Check ChromaDB availability
  const chromaOk = await isChromaDBAvailable();
  if (chromaOk) {
    const status = await getChromaStatus();
    console.log(`ChromaDB: connected (${status.totalChunks} chunks, ${status.sources.length} sources)`);
  } else {
    console.log("ChromaDB: not available — RAG will use in-memory store only");
  }
```

with:

```ts
  const stack = getActiveStack();
  console.log(
    `LLM stack: ${stack.name} (chat ${stack.chatModel} @ ${stack.chatBaseUrl}, embeddings ${stack.embeddingModel} @ ${stack.embedBaseUrl})`
  );

  initGapDB();
  initFeedbackDB();
  initRequestLog();
  await loadIndex();

  // Check ChromaDB availability
  const chromaOk = await isChromaDBAvailable();

  const indexCheck = await verifyIndexes(chromaOk);
  setIndexStatus(indexCheck);
  if (indexCheck.ok) {
    try {
      const added = await ingestKnowledgeDir();
      if (added > 0) {
        await saveIndex();
        console.log(`${added} new chunks ingested from files`);
      }
    } catch (err) {
      console.error("Knowledge file ingestion failed:", err instanceof Error ? err.message : err);
    }
  } else {
    console.error(`Search index check failed: ${indexCheck.reason}`);
  }

  if (chromaOk) {
    const status = await getChromaStatus();
    console.log(`ChromaDB: connected (${status.totalChunks} chunks, ${status.sources.length} sources)`);
  } else {
    console.log("ChromaDB: not available — RAG will use in-memory store only");
  }
```

Replace `  console.log(\`Make sure Ollama is running (ollama serve)\`);` with nothing (delete the line); the stack line above replaces it.

- [ ] **Step 6: Delete the Ollama-specific client and check nothing references it**

```bash
git rm src/services/ollama.ts
grep -rn "ollama.js\|chatWithOllama\|streamChatWithOllama\|getEmbedding\|OllamaMessage" src scripts || echo "no references"
```

Expected: `no references`.

- [ ] **Step 7: Typecheck and run all tests**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add -A src/api/chat.ts src/api/knowledge.ts src/services/gap-detector.ts src/services/news-agent.ts src/server.ts src/services/ollama.ts
git commit -m "feat: route all model calls through the stack-aware LLM client

Adds benchmark mode and per-phase timings to chat, verifies search indexes
at startup, and removes the Ollama-specific client.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Note: after this task, `npm run dev` expects the new models and per-stack indexes. The app is not expected to run end to end until Task 16.

---

### Task 10: Rebuilding the active stack's indexes

**Files:**
- Create: `src/services/reindex.ts`, `scripts/reindex-stack.ts`
- Modify: `src/api/knowledge.ts` (reindex route)
- Test: `__tests__/reindex.test.ts`

**Interfaces:**
- Consumes: `resetIndex`, `ingestTexts`, `saveIndex`, `listKnowledgeFiles`, `readIndexSummary` (Task 6); `addToChromaDB`, `getChromaCollectionInfo`, `isChromaDBAvailable`, `recreateChromaCollection` (Task 7); `listRawDocuments` (Task 5); `checkIndexMeta`, `expectedIndexMeta`, `setIndexStatus`, `IndexCheck` (Task 4); `toBatches` (Task 6); `trackJob` (Task 8).
- Produces:
  - `interface ReindexResult { stack: string; knowledgeFiles: number; rawDocuments: number; memoryChunks: number; chromaChunks: number; seconds: number }`
  - `interface IndexState { memory: { check: IndexCheck; chunkCount: number }; chroma: { check: IndexCheck; count: number } }`
  - `inspectIndexes(): Promise<IndexState>`, `indexesReady(state: IndexState): boolean`, `reindexActiveStack(log?: (message: string) => void): Promise<ReindexResult>`
  - CLI: `LLM_PROVIDER=<stack> npx tsx scripts/reindex-stack.ts [--check|--status]`. `--check` exits 0 when ready, 2 when a rebuild is needed, 1 on error. Rebuild refuses to run while the app answers on `APP_URL` (default `http://localhost:3000`).

- [ ] **Step 1: Write the failing test**

Create `__tests__/reindex.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { indexesReady } from "../src/services/reindex.js";
import type { IndexState } from "../src/services/reindex.js";

const ok = { ok: true, reason: "" };

function state(overrides: Partial<{ memoryOk: boolean; memoryCount: number; chromaOk: boolean; chromaCount: number }>): IndexState {
  const s = { memoryOk: true, memoryCount: 10, chromaOk: true, chromaCount: 10, ...overrides };
  return {
    memory: { check: s.memoryOk ? ok : { ok: false, reason: "memory" }, chunkCount: s.memoryCount },
    chroma: { check: s.chromaOk ? ok : { ok: false, reason: "chroma" }, count: s.chromaCount },
  };
}

describe("indexesReady", () => {
  it("is ready when both indexes match the stack and have content", () => {
    expect(indexesReady(state({}))).toBe(true);
  });

  it("needs a rebuild when either index is incompatible", () => {
    expect(indexesReady(state({ memoryOk: false }))).toBe(false);
    expect(indexesReady(state({ chromaOk: false }))).toBe(false);
  });

  it("needs a rebuild when either index is empty", () => {
    expect(indexesReady(state({ memoryCount: 0 }))).toBe(false);
    expect(indexesReady(state({ chromaCount: 0 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- __tests__/reindex.test.ts`
Expected: FAIL with `Cannot find module '../src/services/reindex.js'`.

- [ ] **Step 3: Implement the service**

Create `src/services/reindex.ts`:

```ts
// Rebuilds the active stack's in-memory index and ChromaDB collection from knowledge/ and data/raw_documents/

import { getActiveStack } from "../config/llm-stacks.js";
import { checkIndexMeta, expectedIndexMeta, setIndexStatus } from "./index-guard.js";
import type { IndexCheck } from "./index-guard.js";
import { ingestTexts, listKnowledgeFiles, readIndexSummary, resetIndex, saveIndex } from "./knowledge-store.js";
import {
  addToChromaDB,
  getChromaCollectionInfo,
  isChromaDBAvailable,
  recreateChromaCollection,
} from "./chromadb-store.js";
import { listRawDocuments } from "./raw-documents.js";
import { parseFile } from "./file-parser.js";
import { toBatches } from "../utils/batches.js";

const RAW_DOCUMENT_BATCH_SIZE = 64;

export interface ReindexResult {
  stack: string;
  knowledgeFiles: number;
  rawDocuments: number;
  memoryChunks: number;
  chromaChunks: number;
  seconds: number;
}

export interface IndexState {
  memory: { check: IndexCheck; chunkCount: number };
  chroma: { check: IndexCheck; count: number };
}

export async function inspectIndexes(): Promise<IndexState> {
  const expected = expectedIndexMeta(getActiveStack());

  const summary = await readIndexSummary();
  const memory = summary === null
    ? { check: { ok: false, reason: "in-memory index file missing" }, chunkCount: 0 }
    : { check: checkIndexMeta(expected, summary.meta, null, "in-memory index"), chunkCount: summary.chunkCount };

  const info = await getChromaCollectionInfo();
  const chroma = info === null
    ? { check: { ok: false, reason: "ChromaDB collection missing" }, count: 0 }
    : { check: checkIndexMeta(expected, info.meta, null, "ChromaDB collection"), count: info.count };

  return { memory, chroma };
}

export function indexesReady(state: IndexState): boolean {
  return state.memory.check.ok
    && state.memory.chunkCount > 0
    && state.chroma.check.ok
    && state.chroma.count > 0;
}

export async function reindexActiveStack(log: (message: string) => void = console.log): Promise<ReindexResult> {
  const startedAt = Date.now();
  const stack = getActiveStack();

  if (!(await isChromaDBAvailable())) {
    throw new Error("ChromaDB is not reachable — start it before reindexing");
  }

  log(`[Reindex] ${stack.name}: rebuilding ${stack.indexFile} and ${stack.chromaCollection}`);
  resetIndex();
  await recreateChromaCollection();

  let memoryChunks = 0;
  let chromaChunks = 0;

  const files = await listKnowledgeFiles();
  for (const file of files) {
    try {
      const text = await parseFile(file.path);
      memoryChunks += await ingestTexts([{ text, source: file.name }]);
      chromaChunks += await addToChromaDB([text], [{ source: file.name }]);
      log(`[Reindex] file ${file.name}`);
    } catch (err) {
      log(`[Reindex] skipped ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const docs = await listRawDocuments();
  let processed = 0;
  for (const batch of toBatches(docs, RAW_DOCUMENT_BATCH_SIZE)) {
    memoryChunks += await ingestTexts(batch.map((doc) => ({ text: doc.content, source: doc.source })));
    chromaChunks += await addToChromaDB(
      batch.map((doc) => doc.content),
      batch.map((doc) => ({ source: doc.source, ...doc.metadata }))
    );
    processed += batch.length;
    log(`[Reindex] raw documents ${processed}/${docs.length}`);
  }

  await saveIndex();
  setIndexStatus({ ok: true, reason: "" });

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  log(`[Reindex] done: ${memoryChunks} in-memory chunks, ${chromaChunks} ChromaDB chunks in ${seconds}s`);

  return {
    stack: stack.name,
    knowledgeFiles: files.length,
    rawDocuments: docs.length,
    memoryChunks,
    chromaChunks,
    seconds,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- __tests__/reindex.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the CLI**

Create `scripts/reindex-stack.ts`:

```ts
// Rebuild or inspect the active stack's search indexes
// Usage:
//   LLM_PROVIDER=mlx npx tsx scripts/reindex-stack.ts            rebuild (PharmaLLM must be stopped)
//   LLM_PROVIDER=mlx npx tsx scripts/reindex-stack.ts --check    exit 0 if ready, 2 if a rebuild is needed
//   LLM_PROVIDER=mlx npx tsx scripts/reindex-stack.ts --status   print index metadata and counts

import { getActiveStack } from "../src/config/llm-stacks.js";
import { isChromaDBAvailable } from "../src/services/chromadb-store.js";
import { indexesReady, inspectIndexes, reindexActiveStack } from "../src/services/reindex.js";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

// A running app keeps its own copy of the in-memory index and would overwrite the rebuilt file
async function appIsRunning(): Promise<boolean> {
  try {
    await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--rebuild";
  const stack = getActiveStack();

  if (!(await isChromaDBAvailable())) {
    console.error("ChromaDB is not reachable. Start it first.");
    process.exit(1);
  }

  if (mode === "--check" || mode === "--status") {
    const state = await inspectIndexes();
    if (mode === "--status") {
      const describe = (ok: boolean, reason: string): string => (ok ? "ok" : reason);
      console.log(
        `${stack.name}: in-memory ${state.memory.chunkCount} chunks (${describe(state.memory.check.ok, state.memory.check.reason)}), ` +
        `ChromaDB ${state.chroma.count} chunks (${describe(state.chroma.check.ok, state.chroma.check.reason)})`
      );
      return;
    }
    process.exit(indexesReady(state) ? 0 : 2);
  }

  if (mode !== "--rebuild") {
    console.error(`Unknown option ${mode}`);
    process.exit(1);
  }

  if (await appIsRunning()) {
    console.error(`PharmaLLM is running at ${APP_URL}. Stop it first, or call POST /api/knowledge/reindex.`);
    process.exit(1);
  }

  await reindexActiveStack();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 6: Make the reindex route rebuild everything on the active stack**

In `src/api/knowledge.ts`, add below the raw-documents import:

```ts
import { reindexActiveStack } from "../services/reindex.js";
```

Replace the whole `router.post("/reindex", …)` handler (from `// POST /api/knowledge/reindex - Re-chunk and re-embed all raw documents` to its closing `});`) with:

```ts
// POST /api/knowledge/reindex - Rebuild the active stack's indexes from knowledge/ and raw documents
router.post("/reindex", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await trackJob("reindex", () => reindexActiveStack());
    res.json({
      message: "Re-indexing complete",
      ...result,
      // Fields kept for existing callers (n8n knowledge QA workflow)
      documents_processed: result.knowledgeFiles + result.rawDocuments,
      chunks_created: result.chromaChunks,
      time_seconds: result.seconds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Reindex] Failed:", message);
    res.status(500).json({ error: message });
  }
});
```

Remove the imports that are now unused in `knowledge.ts`: `recreateChromaCollection` from the chromadb-store import, `RAW_DOCUMENTS_DIR` from the raw-documents import, and `readdir, readFile` from `node:fs/promises` (keep `writeFile, mkdir`). Confirm with:

```bash
grep -n "readdir\|readFile\|recreateChromaCollection\|RAW_DOCUMENTS_DIR" src/api/knowledge.ts || echo "clean"
```

Expected: `clean`.

- [ ] **Step 7: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; all suites pass.

```bash
git add src/services/reindex.ts scripts/reindex-stack.ts src/api/knowledge.ts __tests__/reindex.test.ts
git commit -m "feat: rebuild per-stack indexes from knowledge files and raw documents

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Stack-aware health, chat UI and dashboard

**Files:**
- Create: `src/services/health.ts`
- Modify: `src/api/dashboard.ts`, `public/app.js`, `dashboard/index.html`
- Test: `__tests__/health.test.ts`

**Interfaces:**
- Consumes: `StackConfig`, `getActiveStack` (Task 2); `getIndexStatus` (Task 4); `/api/chat/models` shape and `done` event fields from Task 9.
- Produces:
  - `interface HealthCheck { status: "ok" | "error" | "unreachable"; latency_ms?: number; detail?: string }`
  - `type HealthStatus = "healthy" | "degraded" | "unhealthy"`
  - `CRITICAL_CHECKS: readonly string[]` (`llm_chat`, `llm_embed`, `search_index`)
  - `stackProbeUrls(stack: StackConfig): { llm_chat: string; llm_embed: string }`
  - `probeUrl(url: string, timeoutMs?: number): Promise<HealthCheck>`
  - `aggregateHealth(checks: Record<string, HealthCheck>): HealthStatus`
  - `GET /api/health` → `{ status, stack, checks }` with keys `llm_chat`, `llm_embed`, `search_index`, `chromadb`, `searxng`, `neo4j`, `sqlite`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/health.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import { aggregateHealth, probeUrl, stackProbeUrls } from "../src/services/health.js";
import { sendJson, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("stackProbeUrls", () => {
  it("probes only the active stack's endpoints", () => {
    const { ollama, mlx } = buildStacks({});
    const ollamaUrls = Object.values(stackProbeUrls(ollama));
    const mlxUrls = Object.values(stackProbeUrls(mlx));

    expect(ollamaUrls).toEqual(["http://localhost:11434/v1/models", "http://localhost:11434/v1/models"]);
    expect(mlxUrls).toEqual(["http://localhost:8080/v1/models", "http://localhost:8081/v1/models"]);
    expect(ollamaUrls.some((url) => url.includes(":8080") || url.includes(":8081"))).toBe(false);
    expect(mlxUrls.some((url) => url.includes(":11434"))).toBe(false);
  });
});

describe("aggregateHealth", () => {
  const up = { status: "ok" as const };
  const down = { status: "unreachable" as const };

  it("is healthy when everything is ok", () => {
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: up, searxng: up })).toBe("healthy");
  });

  it("is degraded when only a supporting service is down", () => {
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: up, searxng: down })).toBe("degraded");
  });

  it("is unhealthy when the stack or the search index is down", () => {
    expect(aggregateHealth({ llm_chat: down, llm_embed: up, search_index: up })).toBe("unhealthy");
    expect(aggregateHealth({ llm_chat: up, llm_embed: down, search_index: up })).toBe("unhealthy");
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: { status: "error" } })).toBe("unhealthy");
  });
});

describe("probeUrl", () => {
  it("reports ok, error and unreachable", async () => {
    server = await startFakeServer((req, res) => sendJson(res, req.url === "/ok" ? 200 : 500, {}));

    const ok = await probeUrl(`${server.baseUrl}/ok`);
    expect(ok.status).toBe("ok");
    expect(typeof ok.latency_ms).toBe("number");
    expect((await probeUrl(`${server.baseUrl}/fail`)).status).toBe("error");
    expect((await probeUrl("http://127.0.0.1:9/")).status).toBe("unreachable");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/health.test.ts`
Expected: FAIL with `Cannot find module '../src/services/health.js'`.

- [ ] **Step 3: Implement the health service**

Create `src/services/health.ts`:

```ts
// Stack-aware health checks: only the active stack's endpoints are probed

import type { StackConfig } from "../config/llm-stacks.js";

export interface HealthCheck {
  status: "ok" | "error" | "unreachable";
  latency_ms?: number;
  detail?: string;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

// Chat can't work without these; anything else only degrades answers
export const CRITICAL_CHECKS: readonly string[] = ["llm_chat", "llm_embed", "search_index"];

export function stackProbeUrls(stack: StackConfig): { llm_chat: string; llm_embed: string } {
  return {
    llm_chat: `${stack.chatBaseUrl}/v1/models`,
    llm_embed: `${stack.embedBaseUrl}/v1/models`,
  };
}

export async function probeUrl(url: string, timeoutMs: number = 3000): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: resp.ok ? "ok" : "error", latency_ms: Date.now() - start };
  } catch {
    return { status: "unreachable" };
  }
}

export function aggregateHealth(checks: Record<string, HealthCheck>): HealthStatus {
  const entries = Object.entries(checks);
  if (entries.every(([, check]) => check.status === "ok")) return "healthy";
  const criticalDown = entries.some(([name, check]) => CRITICAL_CHECKS.includes(name) && check.status !== "ok");
  return criticalDown ? "unhealthy" : "degraded";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- __tests__/health.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in `src/api/dashboard.ts`**

Replace:

```ts
import { getStats } from "../services/knowledge-store.js";
```

with:

```ts
import { getStats } from "../services/knowledge-store.js";
import { getActiveStack } from "../config/llm-stacks.js";
import { getIndexStatus } from "../services/index-guard.js";
import { aggregateHealth, probeUrl, stackProbeUrls } from "../services/health.js";
import type { HealthCheck } from "../services/health.js";
```

Delete `const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";`.

Replace the whole `router.get("/health", …)` handler (from `// GET /api/health` to its closing `});`) with:

```ts
// GET /api/health
router.get("/health", async (_req: Request, res: Response): Promise<void> => {
  const stack = getActiveStack();
  const urls = stackProbeUrls(stack);
  const checks: Record<string, HealthCheck> = {};

  // Active LLM stack only; the inactive stack is expected to be stopped
  const [chat, embed] = await Promise.all([probeUrl(urls.llm_chat), probeUrl(urls.llm_embed)]);
  checks.llm_chat = chat;
  checks.llm_embed = embed;

  const indexStatus = getIndexStatus();
  checks.search_index = indexStatus.ok ? { status: "ok" } : { status: "error", detail: indexStatus.reason };

  // ChromaDB
  try {
    const start = Date.now();
    const ok = await isChromaDBAvailable();
    checks.chromadb = {
      status: ok ? "ok" : "unreachable",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.chromadb = { status: "unreachable" };
  }

  // SearXNG
  checks.searxng = await probeUrl(`${SEARXNG_URL}/`);

  // Neo4j
  try {
    const start = Date.now();
    const neo4jOk = await isNeo4jAvailable();
    checks.neo4j = {
      status: neo4jOk ? "ok" : "unreachable",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.neo4j = { status: "unreachable" };
  }

  // SQLite
  checks.sqlite = { status: "ok" };

  res.json({ status: aggregateHealth(checks), stack: stack.name, checks });
});
```

Run: `grep -n "OLLAMA_URL\|ollama" src/api/dashboard.ts || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Update the chat UI in `public/app.js`**

Replace the whole `loadModels` function (from `// Charger les modeles disponibles` through its closing `}`) with:

```js
// Load models from the active LLM stack
async function loadModels() {
  try {
    const res = await fetch("/api/chat/models");
    const data = await res.json();
    const stackLabel = (data.stack || "LLM").toUpperCase();

    if (!res.ok) {
      setStatus(`${stackLabel} stack unavailable - run scripts/switch-stack.sh ${data.stack || ""}`.trim(), "error");
      return;
    }

    // Embedding models can't chat; Ollama also lists the chat model as "<name>:latest"
    const chatModels = (data.models || []).filter(
      (m) => m !== data.embeddingModel && !/embed/i.test(m) && m !== `${data.chatModel}:latest`
    );
    if (data.chatModel && !chatModels.includes(data.chatModel)) {
      chatModels.unshift(data.chatModel);
    }

    if (chatModels.length > 0) {
      const sorted = [...chatModels].sort((a, b) =>
        a === data.chatModel ? -1 : b === data.chatModel ? 1 : 0
      );
      modelSelect.innerHTML = sorted
        .map((m) => `<option value="${m}"${m === data.chatModel ? " selected" : ""}>${m}</option>`)
        .join("");
      setStatus(`${stackLabel} stack connected`, "success");
    } else {
      setStatus(`No chat models found on ${stackLabel}`, "error");
    }
  } catch {
    setStatus("LLM stack unavailable - run scripts/switch-stack.sh", "error");
  }
}
```

Replace the token stats block inside `if (data.done) {`:

```js
          if (data.tokenStats && typeof data.tokenStats.tokensPerSecond === "number") {
            const s = data.tokenStats;
            const statsDiv = document.createElement("div");
            statsDiv.className = "token-stats";
            statsDiv.textContent = `${(s.promptTokens || 0) + (s.completionTokens || 0)} tokens (${s.promptTokens || 0} in \u00b7 ${s.completionTokens || 0} out) \u00b7 ${s.tokensPerSecond.toFixed(1)} tok/s`;
            wrapperDiv.appendChild(statsDiv);
          }
```

with:

```js
          if (data.tokenStats && typeof data.tokenStats.tokensPerSecond === "number") {
            const s = data.tokenStats;
            const stackLabel = data.stack ? `${data.stack.toUpperCase()} · ` : "";
            const statsDiv = document.createElement("div");
            statsDiv.className = "token-stats";
            statsDiv.textContent = `${stackLabel}TTFT ${((s.ttftMs || 0) / 1000).toFixed(1)}s · ${s.tokensPerSecond.toFixed(1)} tok/s · ${s.promptTokens || 0} in / ${s.completionTokens || 0} out`;
            wrapperDiv.appendChild(statsDiv);
          }
```

Replace `addMessage("assistant", "Connection error. Make sure Ollama is running.");` with:

```js
    addMessage("assistant", "Connection error. Make sure PharmaLLM and its LLM stack are running.");
```

- [ ] **Step 7: Update the dashboard in `dashboard/index.html`**

Replace `      <h3>LLM Models (Ollama)</h3>` with:

```html
      <h3>LLM Models (<span id="models-stack">…</span>)</h3>
```

In `renderHealthCards`, replace:

```js
  const icons = { ollama: '\u2699', chromadb: '\u26A1', searxng: '\u{1F50D}', neo4j: '\u{1F578}', sqlite: '\u{1F4BE}' };
  const container = document.getElementById('health-cards');
  container.innerHTML = '';
```

with:

```js
  const icons = { llm_chat: '\u2699', llm_embed: '\u{1F9E0}', search_index: '\u{1F4DA}', chromadb: '\u26A1', searxng: '\u{1F50D}', neo4j: '\u{1F578}', sqlite: '\u{1F4BE}' };
  const container = document.getElementById('health-cards');
  container.innerHTML = '';
  if (health.stack) {
    const stackCard = document.createElement('div'); stackCard.className = 'health-card ok';
    const sn = document.createElement('div'); sn.className = 'health-card-name'; sn.textContent = 'stack'; stackCard.appendChild(sn);
    const ss = document.createElement('div'); ss.className = 'health-card-status status-ok'; ss.textContent = String(health.stack).toUpperCase(); stackCard.appendChild(ss);
    container.appendChild(stackCard);
  }
```

and, in the same function, directly after `card.className = 'health-card ' + (ok ? 'ok' : 'down');`, add:

```js
    if (info.detail) card.title = info.detail;
```

Replace the whole `renderModelsPanel` function with:

```js
async function renderModelsPanel() {
  const panel = document.getElementById('models-panel');
  try {
    const res = await fetch(API_BASE + '/api/chat/models');
    const data = await res.json();
    document.getElementById('models-stack').textContent = (data.stack || '?').toUpperCase();
    if (!res.ok) throw new Error(data.error || 'LLM stack not reachable');

    panel.innerHTML = '';
    for (const name of data.models || []) {
      const isChat = name === data.chatModel || name === data.chatModel + ':latest';
      const isEmbed = name === data.embeddingModel || /embed/i.test(name);
      const card = document.createElement('div'); card.className = 'model-card' + (isChat || name === data.embeddingModel ? ' active' : '');
      const icon = document.createElement('div'); icon.className = 'model-icon ' + (isEmbed ? 'embed' : 'llm'); icon.textContent = isEmbed ? '\u{1F9E0}' : '\u{1F916}'; card.appendChild(icon);
      const info = document.createElement('div'); info.className = 'model-info';
      const mn = document.createElement('div'); mn.className = 'model-name'; mn.textContent = name; info.appendChild(mn);
      const mm = document.createElement('div'); mm.className = 'model-meta';
      mm.textContent = isChat ? 'chat model' : name === data.embeddingModel ? 'embedding model' : 'available';
      info.appendChild(mm);
      card.appendChild(info);
      panel.appendChild(card);
    }
  } catch (err) {
    panel.innerHTML = '';
    const p = document.createElement('p'); p.style.cssText = 'color:#666;text-align:center;padding:40px';
    p.textContent = err instanceof Error ? err.message : 'LLM stack not reachable';
    panel.appendChild(p);
  }
}
```

Run: `grep -n "11434\|mistral-small" public/app.js dashboard/index.html || echo "clean"`
Expected: `clean`.

- [ ] **Step 8: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run test`
Expected: exit 0; all suites pass.

```bash
git add src/services/health.ts src/api/dashboard.ts public/app.js dashboard/index.html __tests__/health.test.ts
git commit -m "feat: make health checks, chat UI and dashboard stack-aware

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: n8n completions through the active stack

The three n8n workflows POST `{ model: 'gemma2:9b', prompt, stream: false }` to Ollama's `/api/generate` and only read `$json.response` downstream. A PharmaLLM endpoint that accepts the same body and returns `{ response }` lets them follow the active stack, Ollama or MLX, with a URL change only (Planning Note 4, confirmed by the user).

**Files:**
- Create: `src/api/llm.ts`
- Modify: `src/server.ts` (mount), `n8n/knowledge_gap_workflow.json`, `n8n/knowledge_gap_workflow_v2.json`, `n8n/knowledge_qa_workflow.json`, `n8n/README.md`
- Test: `__tests__/llm-route.test.ts`

**Interfaces:**
- Consumes: `getLlmClient`, `StackUnavailableError` (Task 3); `isBenchmarkActive`, `trackJob` (Task 8).
- Produces:
  - `interface CompletionRequest { prompt: string; temperature?: number }`
  - `parseCompletionRequest(body: unknown): CompletionRequest | { error: string }`
  - `POST /api/llm/complete` → `200 { response, done: true, stack, model }`; `400` invalid body; `503` benchmark running or stack down; `500` other errors. The body's `model` and `stream` fields are ignored.

- [ ] **Step 1: Write the failing test**

Create `__tests__/llm-route.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { parseCompletionRequest } from "../src/api/llm.js";

describe("parseCompletionRequest", () => {
  it("accepts an Ollama /api/generate body and ignores model and stream", () => {
    expect(parseCompletionRequest({ model: "gemma2:9b", prompt: "Summarize", stream: false })).toEqual({
      prompt: "Summarize",
    });
  });

  it("keeps a numeric temperature", () => {
    expect(parseCompletionRequest({ prompt: "Rate this", temperature: 0.1 })).toEqual({
      prompt: "Rate this",
      temperature: 0.1,
    });
  });

  it("rejects a missing or blank prompt", () => {
    expect(parseCompletionRequest({})).toEqual({ error: "The 'prompt' field is required" });
    expect(parseCompletionRequest({ prompt: "   " })).toEqual({ error: "The 'prompt' field is required" });
    expect(parseCompletionRequest(null)).toEqual({ error: "The 'prompt' field is required" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- __tests__/llm-route.test.ts`
Expected: FAIL with `Cannot find module '../src/api/llm.js'`.

- [ ] **Step 3: Implement the route**

Create `src/api/llm.ts`:

```ts
// Completion endpoint for external workflows (n8n), so they use the active LLM stack instead of calling Ollama directly

import { Router } from "express";
import type { Request, Response } from "express";
import { getLlmClient, StackUnavailableError } from "../services/llm-client.js";
import { isBenchmarkActive, trackJob } from "../services/bench-mode.js";

const router = Router();

export interface CompletionRequest {
  prompt: string;
  temperature?: number;
}

export function parseCompletionRequest(body: unknown): CompletionRequest | { error: string } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.prompt !== "string" || !fields.prompt.trim()) {
    return { error: "The 'prompt' field is required" };
  }
  return typeof fields.temperature === "number"
    ? { prompt: fields.prompt, temperature: fields.temperature }
    : { prompt: fields.prompt };
}

// POST /api/llm/complete - Ollama /api/generate-shaped completion on the active stack
router.post("/complete", async (req: Request, res: Response): Promise<void> => {
  const parsed = parseCompletionRequest(req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (isBenchmarkActive()) {
    res.status(503).json({ error: "Benchmark in progress — try again later" });
    return;
  }

  const llm = getLlmClient();
  try {
    const response = await trackJob("n8n-completion", () =>
      llm.chat([{ role: "user", content: parsed.prompt }], { temperature: parsed.temperature })
    );
    res.json({ response, done: true, stack: llm.stack.name, model: llm.stack.chatModel });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Completion failed";
    res.status(err instanceof StackUnavailableError ? 503 : 500).json({ error: message });
  }
});

export default router;
```

In `src/server.ts`, add below `import benchRouter from "./api/bench.js";`:

```ts
import llmRouter from "./api/llm.js";
```

and below `app.use("/api/bench", benchRouter);`:

```ts
app.use("/api/llm", llmRouter);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- __tests__/llm-route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Point the n8n workflows at PharmaLLM**

```bash
python3 - <<'EOF'
import json
OLD = "http://localhost:11434/api/generate"
NEW = "http://localhost:3000/api/llm/complete"
for path in ["n8n/knowledge_gap_workflow.json", "n8n/knowledge_gap_workflow_v2.json", "n8n/knowledge_qa_workflow.json"]:
    text = open(path, encoding="utf-8").read()
    count = text.count(OLD)
    text = text.replace(OLD, NEW)
    json.loads(text)  # still valid JSON
    open(path, "w", encoding="utf-8").write(text)
    print(path, count)
EOF
grep -rn "11434" n8n/*.json || echo "no Ollama URLs left"
```

Expected: counts `2`, `2`, `1`, then `no Ollama URLs left`. Node names such as `Generate Search Queries (Ollama)` stay unchanged, because n8n connections reference nodes by name.

- [ ] **Step 6: Update the n8n troubleshooting notes**

In `n8n/README.md`, replace:

```markdown
**Ollama timeout :**
- Vérifier que Ollama tourne : `curl http://localhost:11434/api/tags`
- Augmenter le timeout dans les noeuds HTTP Request si nécessaire
- Le modèle `gemma2:9b` doit être pullé : `ollama pull gemma2:9b`
```

with:

```markdown
**Timeout LLM :**
- Les noeuds LLM appellent `http://localhost:3000/api/llm/complete`, qui répond avec le stack actif (Ollama ou MLX)
- Vérifier le stack actif : `curl http://localhost:3000/api/health` (champ `stack`)
- Une réponse 503 pendant un benchmark est normale ; relancer le workflow après le benchmark
- Augmenter le timeout dans les noeuds HTTP Request si nécessaire
```

- [ ] **Step 7: Typecheck, run all tests, commit**

Run: `npm run typecheck && npm run test`
Expected: exit 0; all suites pass.

```bash
git add src/api/llm.ts src/server.ts __tests__/llm-route.test.ts n8n/knowledge_gap_workflow.json n8n/knowledge_gap_workflow_v2.json n8n/knowledge_qa_workflow.json n8n/README.md
git commit -m "feat: route n8n completions through the active LLM stack

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: MLX embedding server

**Files:**
- Create: `python/mlx-embed-server.py`, `python/mlx-requirements.txt`, `python/smoke_embeddings.py`

**Interfaces:**
- Produces:
  - `python/mlx-venv/bin/python python/mlx-embed-server.py --model <repo> --host 127.0.0.1 --port 8081` serving `GET /v1/models` → `{ object: "list", data: [{ id, object: "model" }] }` and `POST /v1/embeddings` with `{ model, input: string | string[] }` → `{ object: "list", model, data: [{ object: "embedding", index, embedding }] }` (L2-normalized, 1024 dimensions for Qwen3-Embedding-0.6B).
  - `python3 python/smoke_embeddings.py --url <base> --model <name>`: exits 0 and prints `PASS` when dimensions, normalization, determinism and relevance ranking are correct. Works against either stack.

This task only creates and syntax-checks the files. They run for real in Task 16, when the MLX stack is active and Ollama is stopped.

- [ ] **Step 1: Pin the MLX dependencies**

Create `python/mlx-requirements.txt`:

```
# MLX stack for PharmaLLM (chat server + embedding server)
mlx-lm==0.31.3
```

- [ ] **Step 2: Write the embedding server**

Create `python/mlx-embed-server.py`:

```python
#!/usr/bin/env python3
"""OpenAI-compatible embedding server for Qwen3-Embedding on MLX.

Serves GET /v1/models and POST /v1/embeddings. Embeddings are the final hidden
state of the last token (the appended <|endoftext|>), L2-normalized, which is
how Qwen3-Embedding's reference implementation pools.

Usage:
  python/mlx-venv/bin/python python/mlx-embed-server.py \
    --model mlx-community/Qwen3-Embedding-0.6B-8bit --host 127.0.0.1 --port 8081
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

import mlx.core as mx
from mlx_lm import load

MAX_TOKENS = 8192
EOS_TOKEN = "<|endoftext|>"


class Embedder:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.model, self.tokenizer = load(model_id)
        self.eos_id = self.tokenizer.convert_tokens_to_ids(EOS_TOKEN)

    def embed(self, text: str) -> list[float]:
        ids = list(self.tokenizer.encode(text))[: MAX_TOKENS - 1]
        # Pooling reads the EOS position, so make sure the sequence ends with it
        if not ids or ids[-1] != self.eos_id:
            ids.append(self.eos_id)
        # model.model returns normalized hidden states without the LM head
        hidden = self.model.model(mx.array([ids]))
        last = hidden[0, -1, :]
        vector = last / mx.maximum(mx.linalg.norm(last), 1e-12)
        mx.eval(vector)
        return vector.tolist()


def make_handler(embedder: Embedder):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/v1/models":
                self._send(200, {"object": "list", "data": [{"id": embedder.model_id, "object": "model"}]})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/v1/embeddings":
                self._send(404, {"error": "not found"})
                return

            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid JSON"})
                return

            inputs = body.get("input")
            if isinstance(inputs, str):
                inputs = [inputs]
            if not isinstance(inputs, list) or not inputs or not all(isinstance(x, str) for x in inputs):
                self._send(400, {"error": "input must be a string or a non-empty list of strings"})
                return

            data = [
                {"object": "embedding", "index": i, "embedding": embedder.embed(text)}
                for i, text in enumerate(inputs)
            ]
            self._send(200, {"object": "list", "model": embedder.model_id, "data": data})

        def log_message(self, format: str, *args: object) -> None:
            # Keep the log readable during reindexing (thousands of requests)
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="mlx-community/Qwen3-Embedding-0.6B-8bit")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()

    embedder = Embedder(args.model)
    # Single-threaded on purpose: MLX evaluation isn't safe to run from several threads
    server = HTTPServer((args.host, args.port), make_handler(embedder))
    print(f"MLX embedding server ready: {args.model} on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write the endpoint smoke test**

Create `python/smoke_embeddings.py`:

```python
#!/usr/bin/env python3
"""Smoke test for an OpenAI-compatible /v1/embeddings endpoint (MLX embedding server or Ollama).

Usage:
  python3 python/smoke_embeddings.py --url http://localhost:8081 --model mlx-community/Qwen3-Embedding-0.6B-8bit
  python3 python/smoke_embeddings.py --url http://localhost:11434 --model qwen3-embedding:0.6b-q8_0
"""

import argparse
import json
import math
import sys
import urllib.request

# Must match QUERY_INSTRUCTION in src/services/llm-client.ts
QUERY_INSTRUCTION = (
    "Given a question about the pharmaceutical industry or its cybersecurity, "
    "retrieve passages that answer the question"
)
EXPECTED_DIM = 1024


def embed(url: str, model: str, texts: list[str]) -> list[list[float]]:
    request = urllib.request.Request(
        f"{url}/v1/embeddings",
        data=json.dumps({"model": model, "input": texts}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        rows = json.load(response)["data"]
    return [row["embedding"] for row in sorted(rows, key=lambda r: r["index"])]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    query = f"Instruct: {QUERY_INSTRUCTION}\nQuery:How does Dell PowerProtect Cyber Recovery isolate backup data?"
    relevant = (
        "Dell PowerProtect Cyber Recovery keeps a copy of critical data in an air-gapped vault "
        "that is disconnected from the production network."
    )
    unrelated = "Semaglutide is a GLP-1 receptor agonist used to treat type 2 diabetes and obesity."

    vectors = embed(args.url, args.model, [query, relevant, unrelated])
    repeat = embed(args.url, args.model, [relevant])[0]

    failures = []
    for i, vector in enumerate(vectors):
        if len(vector) != EXPECTED_DIM:
            failures.append(f"vector {i} has {len(vector)} dimensions, expected {EXPECTED_DIM}")
        norm = math.sqrt(sum(x * x for x in vector))
        if abs(norm - 1.0) > 1e-3:
            failures.append(f"vector {i} has norm {norm:.4f}, expected 1.0")

    determinism = cosine(vectors[1], repeat)
    if determinism < 0.999:
        failures.append(f"the same input gave different vectors (cosine {determinism:.6f})")

    relevant_score = cosine(vectors[0], vectors[1])
    unrelated_score = cosine(vectors[0], vectors[2])
    if relevant_score <= unrelated_score:
        failures.append(f"relevant passage scored {relevant_score:.3f}, unrelated {unrelated_score:.3f}")

    print(
        f"dims={len(vectors[0])} relevant={relevant_score:.3f} "
        f"unrelated={unrelated_score:.3f} determinism={determinism:.6f}"
    )
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Syntax-check both scripts**

Run: `python3 -m py_compile python/mlx-embed-server.py python/smoke_embeddings.py && echo compiled`
Expected: `compiled`.

Run: `python/mlx-venv/bin/python python/mlx-embed-server.py --help`
Expected: usage text listing `--model`, `--host`, `--port` (imports `mlx` and `mlx_lm` without loading a model).

- [ ] **Step 5: Commit**

```bash
git add python/mlx-embed-server.py python/mlx-requirements.txt python/smoke_embeddings.py
git commit -m "feat: add MLX embedding server and embedding endpoint smoke test

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Migrate legacy news and API text to raw documents

**Files:**
- Create: `scripts/lib/legacy-news.ts`, `scripts/migrate-news-to-raw-documents.ts`
- Test: `__tests__/legacy-news.test.ts`

**Interfaces:**
- Consumes: `saveRawDocument`, `listRawDocuments` (Task 5); `listKnowledgeFiles` (Task 6).
- Produces:
  - `interface LegacyChunk { source: string; content: string }`
  - `interface MigrationDoc { key: string; source: string; content: string; metadata: Record<string, unknown> }`
  - `extractNewsLink(content: string): string | null`
  - `collectLegacyDocuments(indexChunks: LegacyChunk[], chromaNewsChunks: LegacyChunk[], fileSources: Set<string>, existingSources: Set<string>): MigrationDoc[]`
  - CLI: `NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/migrate-news-to-raw-documents.ts` (idempotent; reads the legacy index file and legacy `knowledge_base` collection, never modifies them)

- [ ] **Step 1: Write the failing tests**

Create `__tests__/legacy-news.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { collectLegacyDocuments, extractNewsLink } from "../scripts/lib/legacy-news.js";

const article = (date: string, title: string, url: string): string =>
  `[${date}] ${title}\nSource: Reuters\nURL: ${url}`;

describe("extractNewsLink", () => {
  it("reads the URL line of a news item", () => {
    expect(extractNewsLink(article("2026-03-02", "Pfizer deal", "https://news.example/a"))).toBe("https://news.example/a");
  });

  it("returns null when there is no URL line", () => {
    expect(extractNewsLink("[2026-03-02] Headline only")).toBeNull();
  });
});

describe("collectLegacyDocuments", () => {
  it("keeps one document per article across the index and ChromaDB", () => {
    const a = article("2026-03-02", "Pfizer deal", "https://news.example/a");
    const b = article("2026-03-02", "Roche plant", "https://news.example/b");
    const docs = collectLegacyDocuments(
      [{ source: "news-2026-03-02", content: a }],
      [{ source: "news-2026-03-02", content: a }, { source: "news-2026-03-02", content: b }],
      new Set(),
      new Set()
    );
    expect(docs.map((d) => d.key).sort()).toEqual(["https://news.example/a", "https://news.example/b"]);
    expect(docs[0].metadata).toMatchObject({ type: "news", migrated: true });
  });

  it("rebuilds API-added text from its index chunks, without repeats", () => {
    const docs = collectLegacyDocuments(
      [
        { source: "pfizer-overview", content: "Part one" },
        { source: "pfizer-overview", content: "Part two" },
        { source: "pfizer-overview", content: "Part one" },
      ],
      [],
      new Set(),
      new Set()
    );
    expect(docs).toEqual([
      { key: "pfizer-overview", source: "pfizer-overview", content: "Part one\n\nPart two", metadata: { type: "text", migrated: true } },
    ]);
  });

  it("skips knowledge files and sources that already have a raw document", () => {
    const docs = collectLegacyDocuments(
      [
        { source: "vendor-dell-cyber-recovery.md", content: "file chunk" },
        { source: "glp1-market", content: "already saved" },
      ],
      [],
      new Set(["vendor-dell-cyber-recovery.md"]),
      new Set(["glp1-market"])
    );
    expect(docs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/legacy-news.test.ts`
Expected: FAIL with `Cannot find module '../scripts/lib/legacy-news.js'`.

- [ ] **Step 3: Implement the collection logic**

Create `scripts/lib/legacy-news.ts`:

```ts
// Turns chunks from the legacy index and ChromaDB collection back into whole raw documents

export interface LegacyChunk {
  source: string;
  content: string;
}

export interface MigrationDoc {
  key: string;
  source: string;
  content: string;
  metadata: Record<string, unknown>;
}

export function extractNewsLink(content: string): string | null {
  const match = content.match(/^URL: (\S+)$/m);
  return match ? match[1] : null;
}

export function collectLegacyDocuments(
  indexChunks: LegacyChunk[],
  chromaNewsChunks: LegacyChunk[],
  fileSources: Set<string>,
  existingSources: Set<string>
): MigrationDoc[] {
  const docs = new Map<string, MigrationDoc>();
  const textParts = new Map<string, Set<string>>();

  for (const chunk of [...indexChunks, ...chromaNewsChunks]) {
    if (chunk.source.startsWith("news-")) {
      // A news item is a single short chunk; the URL identifies the article
      const link = extractNewsLink(chunk.content);
      const key = link ?? chunk.content;
      if (!docs.has(key)) {
        docs.set(key, {
          key,
          source: chunk.source,
          content: chunk.content,
          metadata: { type: "news", ...(link ? { link } : {}), migrated: true },
        });
      }
    } else if (!fileSources.has(chunk.source) && !existingSources.has(chunk.source)) {
      // Text added through the API before raw documents existed
      const parts = textParts.get(chunk.source) ?? new Set<string>();
      parts.add(chunk.content);
      textParts.set(chunk.source, parts);
    }
  }

  // Only index chunks reach this point for text; ChromaDB input is news-only, so chunks never mix sizes
  for (const [source, parts] of textParts) {
    docs.set(source, {
      key: source,
      source,
      content: [...parts].join("\n\n"),
      metadata: { type: "text", migrated: true },
    });
  }

  return [...docs.values()];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- __tests__/legacy-news.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the migration script**

Create `scripts/migrate-news-to-raw-documents.ts`:

```ts
// One-time migration: save legacy news articles and API-added text as raw documents,
// so every stack's index can be rebuilt from disk. Reads legacy data, never changes it.
// Usage: NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/migrate-news-to-raw-documents.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRawDocuments, saveRawDocument } from "../src/services/raw-documents.js";
import { listKnowledgeFiles } from "../src/services/knowledge-store.js";
import { collectLegacyDocuments } from "./lib/legacy-news.js";
import type { LegacyChunk } from "./lib/legacy-news.js";

const LEGACY_INDEX = join(process.cwd(), "knowledge", ".index.json");
const CHROMADB_URL = process.env.CHROMADB_URL ?? "http://localhost:8100";
const COLLECTIONS_URL = `${CHROMADB_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`;
const LEGACY_COLLECTION = "knowledge_base";

async function readLegacyIndex(): Promise<LegacyChunk[]> {
  try {
    const raw = JSON.parse(await readFile(LEGACY_INDEX, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c): c is LegacyChunk =>
        typeof c === "object" && c !== null
        && typeof (c as LegacyChunk).source === "string"
        && typeof (c as LegacyChunk).content === "string")
      .map((c) => ({ source: c.source, content: c.content }));
  } catch (err) {
    console.warn(`Legacy index not read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function readLegacyChromaNews(): Promise<LegacyChunk[]> {
  try {
    const collections = (await (await fetch(COLLECTIONS_URL)).json()) as Array<{ id: string; name: string }>;
    const legacy = collections.find((c) => c.name === LEGACY_COLLECTION);
    if (!legacy) return [];

    const resp = await fetch(`${COLLECTIONS_URL}/${legacy.id}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include: ["documents", "metadatas"] }),
    });
    const data = (await resp.json()) as { documents: string[]; metadatas: Array<Record<string, unknown> | null> };

    return data.documents
      .map((content, i) => ({ source: String(data.metadatas[i]?.source ?? ""), content }))
      .filter((chunk) => chunk.source.startsWith("news-"));
  } catch (err) {
    console.warn(`Legacy ChromaDB collection not read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function main(): Promise<void> {
  const indexChunks = await readLegacyIndex();
  const chromaNews = await readLegacyChromaNews();
  const fileSources = new Set((await listKnowledgeFiles()).map((f) => f.name));
  const existingBefore = await listRawDocuments();
  const existingSources = new Set(existingBefore.map((d) => d.source));

  console.log(`Legacy index: ${indexChunks.length} chunks; legacy ChromaDB news: ${chromaNews.length} chunks`);

  const docs = collectLegacyDocuments(indexChunks, chromaNews, fileSources, existingSources);
  for (const doc of docs) {
    await saveRawDocument(doc.source, doc.content, doc.metadata, { key: doc.key });
  }

  const news = docs.filter((d) => d.metadata.type === "news").length;
  const after = await listRawDocuments();
  console.log(`Saved ${news} news articles and ${docs.length - news} text documents`);
  console.log(`Raw documents: ${existingBefore.length} before, ${after.length} after`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 6: Run the migration**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/migrate-news-to-raw-documents.ts`
Expected (numbers approximate):
- `Legacy index: 11680 chunks; legacy ChromaDB news: 6869 chunks`
- `Saved <N> news articles and <M> text documents` where N is several thousand (unique article URLs across both sources) and M is small (0–5, since `glp1-market`, `pfizer-overview` and `pharma-cyber-threats` may already exist)
- `Raw documents: 7 before, <7 + N + M> after`

Run it a second time.
Expected: the same `Saved` counts and an unchanged `after` total (files are overwritten, not duplicated).

- [ ] **Step 7: Typecheck, run all tests, commit**

Run: `npm run typecheck:tests && npm run test`
Expected: exit 0; all suites pass.

```bash
git add scripts/lib/legacy-news.ts scripts/migrate-news-to-raw-documents.ts __tests__/legacy-news.test.ts
git commit -m "feat: migrate legacy news and API text into raw documents

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

(`data/raw_documents/` is gitignored; the migrated files stay local.)

---

### Task 15: Stack switch scripts

**Files:**
- Create: `scripts/lib/services.sh`, `scripts/switch-stack.sh`
- Modify: `scripts/start-services.sh` (full rewrite below)
- Test: `__tests__/switch-stack-config.test.ts`

**Interfaces:**
- Consumes: `ollama/qwen3.8-pharma.Modelfile` (Task 0), `python/mlx-requirements.txt` and `python/mlx-embed-server.py` (Task 13), `scripts/reindex-stack.ts --check` (Task 10), `/api/health` `status` field (Task 11), model names in `src/config/llm-stacks.ts` (Task 2).
- Produces:
  - `scripts/switch-stack.sh ollama|mlx`: switch and restart the app, with rollback on failure
  - `scripts/switch-stack.sh ensure-stack ollama|mlx`: start one stack (stopping the other) and make its indexes ready, without starting the app
  - `scripts/switch-stack.sh prepare`: pull/download all models, build `qwen3.8-pharma`, create the MLX venv, then restore the active stack
  - `scripts/switch-stack.sh status`: ports and index counts for both stacks
  - Files: `data/run/active-stack`, `data/run/{app,mlx-chat,mlx-embed}.pid`, `data/logs/{app,mlx-chat,mlx-embed,reindex-<stack>}.log`
  - `scripts/lib/services.sh` functions: `log`, `wait_http URL SECONDS`, `port_open PORT`, `wait_port_closed PORT SECONDS`, `ensure_chromadb`

- [ ] **Step 1: Write the failing consistency test**

The shell script repeats model names and ports from `llm-stacks.ts`. This test fails if they drift apart.

Create `__tests__/switch-stack-config.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStacks } from "../src/config/llm-stacks.js";

const script = readFileSync(join(process.cwd(), "scripts", "switch-stack.sh"), "utf-8");
const modelfile = readFileSync(join(process.cwd(), "ollama", "qwen3.8-pharma.Modelfile"), "utf-8");

function shellVar(name: string): string {
  const match = script.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${name} not found in switch-stack.sh`);
  return match[1];
}

describe("switch-stack.sh stays in sync with llm-stacks.ts", () => {
  const { ollama, mlx } = buildStacks({});

  it("uses the same model names", () => {
    expect(shellVar("OLLAMA_CHAT_MODEL")).toBe(ollama.chatModel);
    expect(shellVar("OLLAMA_EMBED_MODEL")).toBe(ollama.embeddingModel);
    expect(shellVar("MLX_CHAT_MODEL")).toBe(mlx.chatModel);
    expect(shellVar("MLX_EMBED_MODEL")).toBe(mlx.embeddingModel);
  });

  it("uses the same ports", () => {
    expect(ollama.chatBaseUrl).toBe(`http://localhost:${shellVar("OLLAMA_PORT")}`);
    expect(mlx.chatBaseUrl).toBe(`http://localhost:${shellVar("MLX_CHAT_PORT")}`);
    expect(mlx.embedBaseUrl).toBe(`http://localhost:${shellVar("MLX_EMBED_PORT")}`);
  });

  it("builds qwen3.8-pharma from the pulled base model with a 16k context", () => {
    expect(modelfile).toContain(`FROM ${shellVar("OLLAMA_BASE_MODEL")}`);
    expect(modelfile).toContain("PARAMETER num_ctx 16384");
  });

  it("warms up with the same thinking switch the client sends", () => {
    expect(script).toContain(`'"reasoning_effort":"none"'`);
    expect(script).toContain(`'"chat_template_kwargs":{"enable_thinking":false}'`);
    expect(JSON.stringify(ollama.chatExtraBody)).toBe('{"reasoning_effort":"none"}');
    expect(JSON.stringify(mlx.chatExtraBody)).toBe('{"chat_template_kwargs":{"enable_thinking":false}}');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- __tests__/switch-stack-config.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '…/scripts/switch-stack.sh'`.

- [ ] **Step 3: Write the shared service helpers**

Create `scripts/lib/services.sh`:

```bash
#!/usr/bin/env bash
# Shared helpers for start-services.sh and switch-stack.sh. Source this file; don't execute it.

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CHROMA_PORT="${CHROMADB_PORT:-8100}"
CHROMA_URL="http://localhost:${CHROMA_PORT}"
CHROMA_BIN="$PROJECT_DIR/python/venv/bin/chroma"
CHROMA_DATA="$PROJECT_DIR/.chromadb-data"

log() {
  printf '[%s] %s\n' "${LOG_PREFIX:-services}" "$*"
}

# Poll a URL until it answers with 2xx, or give up after SECONDS
wait_http() {
  local url="$1" timeout="$2" waited=0
  until curl -sf -m 2 "$url" >/dev/null 2>&1; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

port_open() {
  nc -z localhost "$1" >/dev/null 2>&1
}

wait_port_closed() {
  local port="$1" timeout="$2" waited=0
  while port_open "$port"; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

ensure_chromadb() {
  if curl -sf "${CHROMA_URL}/api/v2/heartbeat" >/dev/null 2>&1; then
    log "ChromaDB already running on port ${CHROMA_PORT}"
    return 0
  fi

  if [ ! -f "$CHROMA_BIN" ]; then
    log "ChromaDB not installed. Setting up Python venv..."
    python3 -m venv "$PROJECT_DIR/python/venv"
    "$PROJECT_DIR/python/venv/bin/pip" install -q chromadb
  fi

  log "Starting ChromaDB on port ${CHROMA_PORT}..."
  mkdir -p "$CHROMA_DATA"
  nohup "$CHROMA_BIN" run --port "$CHROMA_PORT" --path "$CHROMA_DATA" >/dev/null 2>&1 &
  wait_http "${CHROMA_URL}/api/v2/heartbeat" 30 || { log "ChromaDB failed to start within 30s"; return 1; }
  log "ChromaDB ready"
}
```

- [ ] **Step 4: Write the switch script**

Create `scripts/switch-stack.sh`:

```bash
#!/usr/bin/env bash
# Switch PharmaLLM between the Ollama and MLX stacks. Only one stack runs at a time.
# Usage:
#   scripts/switch-stack.sh ollama|mlx               stop the other stack, start this one, restart the app
#   scripts/switch-stack.sh ensure-stack ollama|mlx  start a stack and its indexes without starting the app
#   scripts/switch-stack.sh prepare                  download models and create the MLX venv (one-time)
#   scripts/switch-stack.sh status                   show the active stack, ports and index counts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="switch-stack"
# shellcheck source=lib/services.sh
source "$SCRIPT_DIR/lib/services.sh"

RUN_DIR="$PROJECT_DIR/data/run"
LOG_DIR="$PROJECT_DIR/data/logs"
MLX_VENV="$PROJECT_DIR/python/mlx-venv"
MLX_PYTHON="${MLX_PYTHON:-python3}"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"
OLLAMA_MANIFESTS="${OLLAMA_MODELS:-$HOME/.ollama/models}/manifests/registry.ollama.ai/library"

APP_PORT="3000"
APP_HTTPS_PORT="3443"
OLLAMA_PORT="11434"
MLX_CHAT_PORT="8080"
MLX_EMBED_PORT="8081"

OLLAMA_BASE_MODEL="qwen3.8:27b-q4_K_M"
OLLAMA_CHAT_MODEL="qwen3.8-pharma"
OLLAMA_EMBED_MODEL="qwen3-embedding:0.6b-q8_0"
MLX_CHAT_MODEL="mlx-community/Qwen3.8-27B-4bit"
MLX_EMBED_MODEL="mlx-community/Qwen3-Embedding-0.6B-8bit"

mkdir -p "$RUN_DIR" "$LOG_DIR"

active_stack() {
  cat "$RUN_DIR/active-stack" 2>/dev/null || echo "ollama"
}

validate_stack() {
  case "$1" in
    ollama|mlx) ;;
    *) log "Unknown stack '$1' (expected ollama or mlx)"; exit 1 ;;
  esac
}

other_stack() {
  if [ "$1" = "mlx" ]; then echo "ollama"; else echo "mlx"; fi
}

# --- Model availability (checked on disk, so no server needs to run) ---------

ollama_manifest() {
  local name="${1%%:*}" tag="${1#*:}"
  [ "$name" = "$1" ] && tag="latest"
  echo "$OLLAMA_MANIFESTS/$name/$tag"
}

hf_snapshot_present() {
  local dir="$HF_CACHE/models--${1//\//--}/snapshots"
  [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]
}

models_ready() {
  case "$1" in
    ollama)
      [ -f "$(ollama_manifest "$OLLAMA_CHAT_MODEL")" ] && [ -f "$(ollama_manifest "$OLLAMA_EMBED_MODEL")" ]
      ;;
    mlx)
      [ -x "$MLX_VENV/bin/mlx_lm.server" ] && hf_snapshot_present "$MLX_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
  esac
}

# --- Stack processes -----------------------------------------------------------

stop_ollama() {
  brew services stop ollama >/dev/null 2>&1 || true
  # launchd restarts a killed Ollama, so only a closed port proves it is down
  wait_port_closed "$OLLAMA_PORT" 30 || { log "Ollama is still listening on :$OLLAMA_PORT"; return 1; }
}

start_ollama() {
  port_open "$OLLAMA_PORT" || brew services start ollama >/dev/null
  wait_http "http://localhost:$OLLAMA_PORT/v1/models" 60 || { log "Ollama did not become ready"; return 1; }
}

stop_pidfile() {
  local name="$1" port="$2" pidfile="$RUN_DIR/$1.pid"
  if [ -f "$pidfile" ]; then
    kill -TERM "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  if ! wait_port_closed "$port" 20; then
    # Whatever still holds the port (for example a server started by hand)
    lsof -tiTCP:"$port" -sTCP:LISTEN | xargs kill -KILL 2>/dev/null || true
    wait_port_closed "$port" 5 || { log "Port $port ($name) is still in use"; return 1; }
  fi
}

stop_mlx() {
  stop_pidfile mlx-chat "$MLX_CHAT_PORT" && stop_pidfile mlx-embed "$MLX_EMBED_PORT"
}

start_mlx() {
  if ! port_open "$MLX_CHAT_PORT"; then
    nohup "$MLX_VENV/bin/mlx_lm.server" --model "$MLX_CHAT_MODEL" --host 127.0.0.1 --port "$MLX_CHAT_PORT" \
      >"$LOG_DIR/mlx-chat.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-chat.pid"
  fi
  if ! port_open "$MLX_EMBED_PORT"; then
    nohup "$MLX_VENV/bin/python" "$PROJECT_DIR/python/mlx-embed-server.py" \
      --model "$MLX_EMBED_MODEL" --host 127.0.0.1 --port "$MLX_EMBED_PORT" \
      >"$LOG_DIR/mlx-embed.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-embed.pid"
  fi
  wait_http "http://localhost:$MLX_CHAT_PORT/v1/models" 180 || { log "mlx_lm.server did not become ready"; return 1; }
  wait_http "http://localhost:$MLX_EMBED_PORT/v1/models" 180 || { log "MLX embedding server did not become ready"; return 1; }
}

start_stack() {
  if [ "$1" = "mlx" ]; then start_mlx; else start_ollama; fi
}

stop_stack() {
  if [ "$1" = "mlx" ]; then stop_mlx; else stop_ollama; fi
}

# Load both models into memory so the first real request doesn't pay for it
warm_up() {
  local chat_url embed_url chat_model embed_model extra
  if [ "$1" = "mlx" ]; then
    chat_url="http://localhost:$MLX_CHAT_PORT"
    embed_url="http://localhost:$MLX_EMBED_PORT"
    chat_model="$MLX_CHAT_MODEL"
    embed_model="$MLX_EMBED_MODEL"
    extra='"chat_template_kwargs":{"enable_thinking":false}'
  else
    chat_url="http://localhost:$OLLAMA_PORT"
    embed_url="$chat_url"
    chat_model="$OLLAMA_CHAT_MODEL"
    embed_model="$OLLAMA_EMBED_MODEL"
    extra='"reasoning_effort":"none"'
  fi

  log "Warming up $1..."
  curl -sf -m 600 "$chat_url/v1/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$chat_model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}],\"max_tokens\":5,$extra}" \
    >/dev/null || { log "Chat warm-up failed"; return 1; }
  curl -sf -m 120 "$embed_url/v1/embeddings" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$embed_model\",\"input\":\"warm-up\"}" \
    >/dev/null || { log "Embedding warm-up failed"; return 1; }
}

ensure_index() {
  local rc=0
  (cd "$PROJECT_DIR" && LLM_PROVIDER="$1" npx tsx scripts/reindex-stack.ts --check) || rc=$?
  case "$rc" in
    0)
      log "Indexes for $1 are ready"
      ;;
    2)
      log "Building indexes for $1 (re-embeds the whole knowledge base, see $LOG_DIR/reindex-$1.log)..."
      (cd "$PROJECT_DIR" && LLM_PROVIDER="$1" npx tsx scripts/reindex-stack.ts) >"$LOG_DIR/reindex-$1.log" 2>&1 \
        || { log "Reindex failed"; tail -n 15 "$LOG_DIR/reindex-$1.log"; return 1; }
      tail -n 1 "$LOG_DIR/reindex-$1.log"
      ;;
    *)
      log "Index check failed (exit $rc)"
      return 1
      ;;
  esac
}

# --- PharmaLLM app --------------------------------------------------------------

stop_app() {
  local pidfile="$RUN_DIR/app.pid" port
  if [ -f "$pidfile" ]; then
    pkill -TERM -P "$(cat "$pidfile")" 2>/dev/null || true
    kill -TERM "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  # Also stop an app started another way (npm run dev, manual tsx); tsx watch would respawn its child
  pkill -TERM -f "tsx watch src/server.ts" 2>/dev/null || true
  for port in "$APP_PORT" "$APP_HTTPS_PORT"; do
    lsof -tiTCP:"$port" -sTCP:LISTEN | xargs kill -TERM 2>/dev/null || true
  done
  if ! wait_port_closed "$APP_PORT" 20 || ! wait_port_closed "$APP_HTTPS_PORT" 20; then
    log "App ports are still in use"
    return 1
  fi
}

start_app() {
  cd "$PROJECT_DIR"
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
  echo $! >"$RUN_DIR/app.pid"

  local waited=0 status=""
  while [ "$waited" -lt 180 ]; do
    status="$(curl -sf -m 5 "http://localhost:$APP_PORT/api/health" 2>/dev/null \
      | python3 -c 'import sys, json; print(json.load(sys.stdin)["status"])' 2>/dev/null || true)"
    case "$status" in
      healthy) log "PharmaLLM is up on the $1 stack"; return 0 ;;
      degraded) log "PharmaLLM is up on the $1 stack (degraded: a supporting service is down)"; return 0 ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  log "PharmaLLM did not become healthy (last status: ${status:-no response})"
  return 1
}

show_logs() {
  local file
  for file in "$LOG_DIR/mlx-chat.log" "$LOG_DIR/mlx-embed.log" "$LOG_DIR/app.log"; do
    [ -f "$file" ] || continue
    log "--- last lines of $(basename "$file") ---"
    tail -n 15 "$file"
  done
}

# --- Commands ---------------------------------------------------------------------

switch_to() {
  local target="$1" previous
  previous="$(active_stack)"
  validate_stack "$target"
  models_ready "$target" || { log "Models for $target are missing. Run: scripts/switch-stack.sh prepare"; exit 1; }
  ensure_chromadb

  log "Switching: $previous -> $target"
  stop_app
  stop_stack "$(other_stack "$target")"

  if start_stack "$target" && warm_up "$target" && ensure_index "$target" && start_app "$target"; then
    echo "$target" >"$RUN_DIR/active-stack"
    log "Active stack: $target"
    return 0
  fi

  show_logs
  if [ "$previous" != "$target" ]; then
    log "Rolling back to $previous..."
    stop_app || true
    stop_stack "$target" || true
    if start_stack "$previous" && warm_up "$previous" && start_app "$previous"; then
      log "Rolled back to $previous"
    else
      log "Rollback to $previous failed too; see $LOG_DIR"
    fi
  fi
  exit 1
}

ensure_stack() {
  local target="$1"
  validate_stack "$target"
  models_ready "$target" || { log "Models for $target are missing. Run: scripts/switch-stack.sh prepare"; exit 1; }
  stop_stack "$(other_stack "$target")"
  if ! { start_stack "$target" && warm_up "$target" && ensure_index "$target"; }; then
    show_logs
    exit 1
  fi
  echo "$target" >"$RUN_DIR/active-stack"
}

prepare() {
  local previous
  previous="$(active_stack)"
  log "Preparing both stacks (about 33 GB of downloads on the first run)"
  stop_app

  # Ollama models: pulling needs the Ollama service, so MLX must be down first
  stop_mlx
  start_ollama
  ollama pull "$OLLAMA_BASE_MODEL"
  ollama pull "$OLLAMA_EMBED_MODEL"
  ollama create "$OLLAMA_CHAT_MODEL" -f "$PROJECT_DIR/ollama/qwen3.8-pharma.Modelfile"

  # MLX models: files only, no server is started here
  [ -x "$MLX_VENV/bin/python" ] || "$MLX_PYTHON" -m venv "$MLX_VENV"
  "$MLX_VENV/bin/pip" install -q -r "$PROJECT_DIR/python/mlx-requirements.txt"
  "$MLX_VENV/bin/python" -c "from huggingface_hub import snapshot_download as d; d('$MLX_CHAT_MODEL'); d('$MLX_EMBED_MODEL')"

  log "Models ready. Restoring the $previous stack..."
  switch_to "$previous"
}

status() {
  log "Active stack: $(active_stack)"
  local entry name port stack
  for entry in "app:$APP_PORT" "ollama:$OLLAMA_PORT" "mlx-chat:$MLX_CHAT_PORT" "mlx-embed:$MLX_EMBED_PORT" "chromadb:$CHROMA_PORT"; do
    name="${entry%%:*}"
    port="${entry#*:}"
    if port_open "$port"; then log "  $name (:$port) up"; else log "  $name (:$port) down"; fi
  done
  if curl -sf "${CHROMA_URL}/api/v2/heartbeat" >/dev/null 2>&1; then
    for stack in ollama mlx; do
      (cd "$PROJECT_DIR" && LLM_PROVIDER="$stack" npx tsx scripts/reindex-stack.ts --status) || true
    done
  fi
}

case "${1:-}" in
  ollama|mlx) switch_to "$1" ;;
  ensure-stack) ensure_stack "${2:-}" ;;
  prepare) prepare ;;
  status) status ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
esac
```

Make it executable:

Run: `chmod +x scripts/switch-stack.sh`

- [ ] **Step 5: Rewrite `scripts/start-services.sh`**

Replace the whole file with:

```bash
#!/usr/bin/env bash
# Start ChromaDB, the active LLM stack and the PharmaLLM dev server
# Usage: ./scripts/start-services.sh   (switch stacks with scripts/switch-stack.sh ollama|mlx)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="start-services"
# shellcheck source=lib/services.sh
source "$SCRIPT_DIR/lib/services.sh"

STACK="$(cat "$PROJECT_DIR/data/run/active-stack" 2>/dev/null || echo ollama)"

cleanup() {
  echo ""
  log "Shutting down services..."
  # Kill all child processes
  kill 0 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

ensure_chromadb
"$SCRIPT_DIR/switch-stack.sh" ensure-stack "$STACK"

log "Starting PharmaLLM dev server on the $STACK stack..."
cd "$PROJECT_DIR"
export CHROMADB_URL="$CHROMA_URL"
export LLM_PROVIDER="$STACK"
npx tsx watch src/server.ts &

# Wait for all background processes
wait
```

- [ ] **Step 6: Run the consistency test and syntax checks**

Run: `npm run test -- __tests__/switch-stack-config.test.ts`
Expected: PASS, 4 tests.

Run: `bash -n scripts/lib/services.sh && bash -n scripts/switch-stack.sh && bash -n scripts/start-services.sh && echo syntax-ok`
Expected: `syntax-ok`.

Run: `scripts/switch-stack.sh; echo "exit=$?"`
Expected: the 6 usage lines from the script header, then `exit=1`.

Run: `scripts/switch-stack.sh status`
Expected: `Active stack: ollama` and one up/down line per port (app, ollama, mlx-chat, mlx-embed, chromadb). The index lines report `in-memory index file missing` and `ChromaDB collection missing` for both stacks, because no per-stack index exists yet.

- [ ] **Step 7: Run all tests and commit**

Run: `npm run test`
Expected: all suites pass.

```bash
git add scripts/lib/services.sh scripts/switch-stack.sh scripts/start-services.sh __tests__/switch-stack-config.test.ts
git commit -m "feat: add stack switch script with rollback and stack-aware dev startup

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: First bring-up of both stacks

Builds both indexes, checks embeddings on each stack, compares them across stacks, and proves that switching and rollback work.

**Files:**
- Create: `scripts/lib/stats.ts`, `scripts/embedding-parity.ts`
- Test: `__tests__/stats.test.ts`

**Interfaces:**
- Consumes: `getLlmClient`, `EmbedKind` (Task 3); `scripts/switch-stack.sh` (Task 15); `python/smoke_embeddings.py` (Task 13).
- Produces (from `scripts/lib/stats.ts`):
  - `percentile(values: number[], p: number): number | null` (nearest-rank)
  - `median(values: number[]): number | null`
  - `jaccard(a: string[], b: string[]): number`
  - `cosine(a: ArrayLike<number>, b: ArrayLike<number>): number`
  - `percentChange(from: number, to: number): number | null`
- CLI: `scripts/embedding-parity.ts save <file>` (active stack) and `compare <a> <b>` (exit 1 when mean cosine < 0.98)

- [ ] **Step 1: Write the failing stats tests**

Create `__tests__/stats.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { cosine, jaccard, median, percentChange, percentile } from "../scripts/lib/stats.js";

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 90)).toBe(50);
    expect(percentile(values, 0)).toBe(15);
  });

  it("returns null for no values", () => {
    expect(percentile([], 50)).toBeNull();
    expect(median([])).toBeNull();
  });

  it("does not reorder the input", () => {
    const values = [3, 1, 2];
    expect(median(values)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("jaccard", () => {
  it("measures overlap of two ID lists", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("treats two empty lists as identical", () => {
    expect(jaccard([], [])).toBe(1);
  });
});

describe("cosine", () => {
  it("is 1 for parallel vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 for a zero vector or different lengths", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1], [1, 1])).toBe(0);
  });
});

describe("percentChange", () => {
  it("computes the relative change", () => {
    expect(percentChange(20, 25)).toBeCloseTo(25);
    expect(percentChange(20, 15)).toBeCloseTo(-25);
  });

  it("returns null when the baseline is zero", () => {
    expect(percentChange(0, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- __tests__/stats.test.ts`
Expected: FAIL with `Cannot find module '../scripts/lib/stats.js'`.

- [ ] **Step 3: Implement the stats helpers**

Create `scripts/lib/stats.ts`:

```ts
// Small statistics helpers for benchmark and parity scripts

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const item of setA) {
    if (setB.has(item)) shared++;
  }
  return shared / (setA.size + setB.size - shared);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

export function percentChange(from: number, to: number): number | null {
  return from === 0 ? null : ((to - from) / from) * 100;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- __tests__/stats.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the parity script**

Create `scripts/embedding-parity.ts`:

```ts
// Cross-stack embedding parity check. The stacks run one after the other, never together.
// Usage:
//   LLM_PROVIDER=ollama npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-ollama.json
//   LLM_PROVIDER=mlx    npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-mlx.json
//   npx tsx scripts/embedding-parity.ts compare data/benchmarks/parity-ollama.json data/benchmarks/parity-mlx.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLlmClient } from "../src/services/llm-client.js";
import { cosine } from "./lib/stats.js";

interface ParityFile {
  stack: string;
  embeddingModel: string;
  documents: number[][];
  queries: number[][];
}

const MIN_MEAN_COSINE = 0.98;

const DOCUMENTS = [
  "Dell PowerProtect Cyber Recovery keeps an isolated copy of critical data in an air-gapped vault.",
  "Pure Storage SafeMode snapshots cannot be deleted or modified, even with administrator credentials.",
  "NotPetya disrupted Merck's manufacturing and cost the company an estimated 870 million dollars in 2017.",
  "Basel hosts the global headquarters of Novartis and Roche and a dense cluster of biotech companies.",
  "21 CFR Part 11 defines FDA requirements for electronic records and electronic signatures.",
  "Semaglutide and tirzepatide lead the fast-growing GLP-1 market for diabetes and obesity.",
  "CrowdStrike Falcon provides endpoint detection and response through a lightweight cloud-managed agent.",
  "The NIS2 directive extends EU cybersecurity obligations to pharmaceutical manufacturers.",
  "Bug Bounty Switzerland runs ethical hacking programs for Swiss companies from Zurich.",
  "A manufacturing execution system coordinates batch production steps on the plant floor.",
];

const QUERIES = [
  "How does Dell isolate backups from ransomware?",
  "Can an attacker delete Pure Storage snapshots?",
  "What did the NotPetya attack cost Merck?",
  "Which pharma companies are based in Basel?",
  "What does 21 CFR Part 11 regulate?",
  "Which drugs dominate the GLP-1 market?",
  "What is CrowdStrike Falcon?",
  "Does NIS2 apply to drug manufacturers?",
  "Who is Bug Bounty Switzerland?",
  "What does an MES do in a pharma plant?",
];

async function save(path: string): Promise<void> {
  const client = getLlmClient();
  const file: ParityFile = {
    stack: client.stack.name,
    embeddingModel: client.stack.embeddingModel,
    documents: await client.embedMany(DOCUMENTS, "document"),
    queries: await client.embedMany(QUERIES, "query"),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file), "utf-8");
  console.log(`Saved ${DOCUMENTS.length + QUERIES.length} embeddings from ${file.stack} to ${path}`);
}

async function compare(pathA: string, pathB: string): Promise<void> {
  const a = JSON.parse(await readFile(pathA, "utf-8")) as ParityFile;
  const b = JSON.parse(await readFile(pathB, "utf-8")) as ParityFile;
  const vectorsA = [...a.documents, ...a.queries];
  const vectorsB = [...b.documents, ...b.queries];

  if (vectorsA.length !== vectorsB.length) {
    console.error(`Different sample counts: ${vectorsA.length} vs ${vectorsB.length}`);
    process.exit(1);
  }

  const scores = vectorsA.map((vector, i) => cosine(vector, vectorsB[i]));
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const min = Math.min(...scores);

  console.log(`${a.stack} vs ${b.stack}: mean cosine ${mean.toFixed(4)}, min ${min.toFixed(4)} over ${scores.length} texts`);
  if (mean < MIN_MEAN_COSINE) {
    console.error(`FAIL: mean cosine below ${MIN_MEAN_COSINE}`);
    process.exit(1);
  }
  console.log("PASS");
}

async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  if (command === "save" && first) return save(first);
  if (command === "compare" && first && second) return compare(first, second);
  console.error("Usage: embedding-parity.ts save <file> | compare <a> <b>");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

Run: `npm run typecheck:tests`
Expected: exit 0.

- [ ] **Step 6: Commit the helpers before touching running services**

```bash
git add scripts/lib/stats.ts scripts/embedding-parity.ts __tests__/stats.test.ts
git commit -m "feat: add stats helpers and cross-stack embedding parity check

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Prepare models and bring up the Ollama stack**

Tell the user this stops the currently running PharmaLLM, and that the first run re-embeds the whole knowledge base on Ollama (roughly 20,000 embeddings; expect tens of minutes).

Run (with `MLX_PYTHON=/opt/homebrew/bin/python3.12` in front if Task 0 required it): `scripts/switch-stack.sh prepare`
Expected, in order:
- `ollama pull` output ending in `success` (fast if Task 0 already pulled)
- `Models ready. Restoring the ollama stack...`
- `Building indexes for ollama …` followed by a `[Reindex] done: … in-memory chunks, … ChromaDB chunks in …s` line
- `PharmaLLM is up on the ollama stack` (or `degraded` if SearXNG/Neo4j are down)
- `Active stack: ollama`

Run: `scripts/switch-stack.sh status`
Expected: `app`, `ollama`, `chromadb` up; `mlx-chat` and `mlx-embed` down; `ollama: in-memory <N> chunks (ok), ChromaDB <M> chunks (ok)`; the mlx line still reports missing indexes.

- [ ] **Step 8: Check the Ollama stack end to end**

```bash
python3 python/smoke_embeddings.py --url http://localhost:11434 --model qwen3-embedding:0.6b-q8_0
LLM_PROVIDER=ollama npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-ollama.json
curl -s localhost:3000/api/health | python3 -m json.tool
curl -sN localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"How does Dell PowerProtect Cyber Recovery protect backups?","benchmark":true}' | tail -n 2
```

Expected:
- Smoke test prints `PASS`.
- Parity file saved with 20 embeddings from `ollama`.
- Health shows `"stack": "ollama"` and `llm_chat`, `llm_embed`, `search_index` all `ok`.
- The last chat event is `data: {"done":true,…,"stack":"ollama",…,"timings":{…},"chunkIds":[…]}` with non-zero `ttftMs` and `decodeTokPerSec`.

- [ ] **Step 9: Switch to MLX**

Run: `scripts/switch-stack.sh mlx`
Expected: `Switching: ollama -> mlx`, then an index build for mlx (as long as Step 7's), `PharmaLLM is up on the mlx stack`, `Active stack: mlx`.

Run: `lsof -iTCP:11434 -sTCP:LISTEN -nP || echo "ollama stopped"`
Expected: `ollama stopped`.

- [ ] **Step 10: Check the MLX stack and embedding parity**

```bash
python3 python/smoke_embeddings.py --url http://localhost:8081 --model mlx-community/Qwen3-Embedding-0.6B-8bit
LLM_PROVIDER=mlx npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-mlx.json
npx tsx scripts/embedding-parity.ts compare data/benchmarks/parity-ollama.json data/benchmarks/parity-mlx.json
curl -sN localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"How does Dell PowerProtect Cyber Recovery protect backups?","benchmark":true}' | tail -n 2
```

Expected:
- Smoke test prints `PASS`.
- Compare prints `ollama vs mlx: mean cosine ≥ 0.98 …` and `PASS`.
- The chat's last event has `"stack":"mlx"` and non-zero timings.

If the smoke test fails on relevance or the parity mean is below 0.98, stop and check the pooling in `python/mlx-embed-server.py` first: the input must end with token 151643 (`<|endoftext|>`) and pooling must read that last position. Don't benchmark with a mismatched embedding server.

- [ ] **Step 11: Prove rollback works**

Occupy the MLX embedding port with a server that answers 404 on `/v1/models`, then try to switch back to MLX from Ollama:

```bash
scripts/switch-stack.sh ollama
python3 -m http.server 8081 --bind 127.0.0.1 >/dev/null 2>&1 &
scripts/switch-stack.sh mlx; echo "exit=$?"
curl -s localhost:3000/api/health | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["stack"], d["status"])'
lsof -iTCP:8081 -sTCP:LISTEN -nP || echo "8081 free"
```

Expected:
- The first command ends with `Active stack: ollama`.
- The `mlx` switch waits up to 180 s, prints `MLX embedding server did not become ready`, the log tails, `Rolling back to ollama...`, `Rolled back to ollama`, then `exit=1`.
- Health prints `ollama healthy` (or `ollama degraded`).
- `8081 free` (the rollback's `stop_mlx` also cleared the blocking server).

- [ ] **Step 12: Record the bring-up results**

Append a "Bring-up" section to `docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md` with: index build times and chunk counts per stack (from `data/logs/reindex-*.log`), both smoke outputs, the parity mean/min, and the rollback transcript.

```bash
git add docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md
git commit -m "docs: record stack bring-up, parity and rollback results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Benchmark runner and comparison report

**Files:**
- Create: `bench/questions.json`, `scripts/lib/benchmark-types.ts`, `scripts/lib/benchmark-report.ts`, `scripts/benchmark-stack.ts`, `scripts/compare-benchmarks.ts`
- Test: `__tests__/benchmark-report.test.ts`

**Interfaces:**
- Consumes: `ChatTimings` (Task 8); `parseSseLines` (Task 3); `percentile`, `median`, `jaccard`, `percentChange` (Task 16); `/api/bench/*` (Task 8); `/api/chat` `benchmark` mode and `/api/chat/models` (Task 9); `/api/health` (Task 11).
- Produces:
  - Types in `scripts/lib/benchmark-types.ts`: `BenchQuestion`, `RunResult`, `QuestionResult`, `BenchEnvironment`, `MemoryPeak`, `BenchmarkFile`
  - From `scripts/lib/benchmark-report.ts`: `METRICS`, `metricValues(file, key)`, `summarizeMetrics(a, b): MetricSummary[]`, `meanRetrievalOverlap(a, b): number | null`, `errorCount(file): number`, `orderByStack(x, y): [BenchmarkFile, BenchmarkFile]`, `buildMarkdownReport(a, b): string`, `buildReview(a, b, random?): { items: ReviewItem[]; key: ReviewKey[] }`, `buildReviewHtml(items, key, storageId): string`
  - CLI: `npx tsx scripts/benchmark-stack.ts [--runs 3] [--app http://localhost:3000] [--questions bench/questions.json]` → `data/benchmarks/<stack>-<timestamp>.json`
  - CLI: `npx tsx scripts/compare-benchmarks.ts <a.json> <b.json>` → prints the report, writes `data/benchmarks/compare-<timestamp>.md` and `data/benchmarks/review-<timestamp>.html`

- [ ] **Step 1: Add the question set**

Create `bench/questions.json`:

```json
[
  { "id": "vendor-dell", "category": "vendor", "question": "How does Dell PowerProtect Cyber Recovery protect a pharma company's backups from ransomware?" },
  { "id": "vendor-pure", "category": "vendor", "question": "What does Pure Storage SafeMode do, and how would a manufacturer use it to recover a MES system?" },
  { "id": "vendor-netapp", "category": "vendor", "question": "Which NetApp capabilities help protect clinical trial data from cyberattacks?" },
  { "id": "vendor-hpe", "category": "vendor", "question": "How can HPE solutions support cyber resilience at a pharmaceutical manufacturing site?" },
  { "id": "vendor-nvidia", "category": "vendor", "question": "How can NVIDIA security products be used to detect threats in pharma networks?" },
  { "id": "vendor-vast-weka", "category": "vendor", "question": "Compare VAST Data and WEKA for protecting research data in drug discovery." },
  { "id": "vendor-siem", "category": "vendor", "question": "How do Splunk, Microsoft Sentinel and CrowdStrike differ for a pharma security operations center?" },
  { "id": "vendor-sap", "category": "vendor", "question": "What are the main security risks for SAP systems at pharmaceutical companies?" },
  { "id": "vendor-servicenow", "category": "vendor", "question": "How can ServiceNow help a pharma company respond to a cyber incident?" },
  { "id": "vendor-data-platforms", "category": "vendor", "question": "What security controls do Snowflake and Databricks offer for regulated pharma data?" },
  { "id": "vendor-bbs", "category": "vendor", "question": "What does Bug Bounty Switzerland offer to Swiss pharmaceutical companies?" },
  { "id": "threat-notpetya", "category": "threat", "question": "What happened to Merck during the NotPetya attack and what did it cost?" },
  { "id": "threat-types", "category": "threat", "question": "What are the most common types of cyberattacks against pharmaceutical companies?" },
  { "id": "threat-costs", "category": "threat", "question": "How much does manufacturing downtime from a cyberattack cost a pharma company per day?" },
  { "id": "threat-by-year", "category": "threat", "question": "Which major cyberattacks hit pharmaceutical companies between 2020 and 2025?" },
  { "id": "threat-systems", "category": "threat", "question": "Which systems are most often compromised in pharma cyber incidents?" },
  { "id": "regulation-part11", "category": "regulation", "question": "What does 21 CFR Part 11 require for electronic records in pharmaceutical manufacturing?" },
  { "id": "regulation-nis2", "category": "regulation", "question": "How does the NIS2 directive affect pharmaceutical companies in Europe?" },
  { "id": "pharma-basel", "category": "pharma", "question": "Why is Basel a concentration risk for the pharmaceutical supply chain?" },
  { "id": "pharma-pipeline", "category": "pharma", "question": "Which Phase 3 drug candidates are expected to have the highest peak sales?" },
  { "id": "uncovered-anvisa", "category": "uncovered", "question": "What cybersecurity requirements does Brazil's ANVISA impose on medical device software?" },
  { "id": "uncovered-vet-coldchain", "category": "uncovered", "question": "How do veterinary pharmaceutical companies secure their cold-chain logistics systems?" },
  { "id": "uncovered-singapore-dc", "category": "uncovered", "question": "What does it typically cost to build a Tier III data center in Singapore per megawatt?" }
]
```

- [ ] **Step 2: Add the shared types**

Create `scripts/lib/benchmark-types.ts`:

```ts
// Types shared by the benchmark runner and the comparison report

import type { ChatTimings } from "../../src/services/bench-mode.js";

export interface BenchQuestion {
  id: string;
  category: string;
  question: string;
}

export interface RunResult {
  run: number;
  answer: string;
  timings: ChatTimings | null;
  chunkIds: string[];
  error?: string;
}

export interface QuestionResult extends BenchQuestion {
  runs: RunResult[];
}

export interface BenchEnvironment {
  macos: string;
  chip: string;
  thermal: string;
  stackVersion: string;
  chatModel: string;
  embeddingModel: string;
}

export interface MemoryPeak {
  processMb: number;
  systemUsedMb: number;
}

export interface BenchmarkFile {
  stack: string;
  startedAt: string;
  finishedAt: string;
  runsPerQuestion: number;
  environment: BenchEnvironment;
  memoryPeak: MemoryPeak;
  questions: QuestionResult[];
}
```

- [ ] **Step 3: Write the failing report tests**

Create `__tests__/benchmark-report.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import type { ChatTimings } from "../src/services/bench-mode.js";
import type { BenchmarkFile, RunResult } from "../scripts/lib/benchmark-types.js";
import {
  buildMarkdownReport,
  buildReview,
  buildReviewHtml,
  errorCount,
  meanRetrievalOverlap,
  metricValues,
  orderByStack,
  summarizeMetrics,
} from "../scripts/lib/benchmark-report.js";

function timings(ttftMs: number, decodeTokPerSec: number): ChatTimings {
  return { embedMs: 10, retrievalMs: 20, ttftMs, decodeTokPerSec, promptTokens: 2000, completionTokens: 200, totalMs: ttftMs + 5000 };
}

function run(n: number, t: ChatTimings | null, chunkIds: string[], answer: string, error?: string): RunResult {
  return { run: n, answer, timings: t, chunkIds, ...(error ? { error } : {}) };
}

function file(stack: string, runs: RunResult[][]): BenchmarkFile {
  return {
    stack,
    startedAt: "2026-09-16T10:00:00.000Z",
    finishedAt: "2026-09-16T11:00:00.000Z",
    runsPerQuestion: 3,
    environment: { macos: "26.4", chip: "Apple M4 Pro", thermal: "No thermal warning level has been recorded", stackVersion: "x", chatModel: "chat", embeddingModel: "embed" },
    memoryPeak: { processMb: 18000, systemUsedMb: 30000 },
    questions: runs.map((r, i) => ({ id: `q${i}`, category: "vendor", question: `Question ${i}?`, runs: r })),
  };
}

const ollama = file("ollama", [
  [run(1, timings(4000, 16), ["a", "b"], "Ollama answer 0"), run(2, timings(6000, 18), ["a", "b"], "x")],
  [run(1, timings(5000, 17), ["c"], "Ollama answer 1"), run(2, null, [], "", "HTTP 500")],
]);
const mlx = file("mlx", [
  [run(1, timings(2000, 20), ["a", "c"], "MLX answer 0"), run(2, timings(3000, 22), ["a", "c"], "y")],
  [run(1, timings(2500, 21), ["c"], "MLX answer 1")],
]);

describe("metrics", () => {
  it("ignores failed runs", () => {
    expect(metricValues(ollama, "ttftMs")).toEqual([4000, 6000, 5000]);
    expect(errorCount(ollama)).toBe(1);
    expect(errorCount(mlx)).toBe(0);
  });

  it("summarizes medians, p90 and the change from A to B", () => {
    const ttft = summarizeMetrics(ollama, mlx).find((m) => m.key === "ttftMs");
    expect(ttft).toMatchObject({ medianA: 5000, p90A: 6000, medianB: 2500, p90B: 3000, changePct: -50 });
  });

  it("averages retrieval overlap of each question's first run", () => {
    // q0: {a,b} vs {a,c} = 1/3; q1: {c} vs {c} = 1
    expect(meanRetrievalOverlap(ollama, mlx)).toBeCloseTo((1 / 3 + 1) / 2);
  });
});

describe("orderByStack", () => {
  it("puts ollama first so changes read as MLX relative to Ollama", () => {
    expect(orderByStack(mlx, ollama).map((f) => f.stack)).toEqual(["ollama", "mlx"]);
  });
});

describe("buildMarkdownReport", () => {
  it("includes the performance table, memory, errors and overlap", () => {
    const report = buildMarkdownReport(ollama, mlx);
    expect(report).toContain("| TTFT (ms) | 5000 | 6000 | 2500 | 3000 | -50.0% |");
    expect(report).toContain("Peak stack process memory");
    expect(report).toContain("Failed runs: ollama 1, mlx 0");
    expect(report).toContain("Retrieval overlap");
  });
});

describe("buildReview", () => {
  it("randomizes answer order per question and records the key", () => {
    const flips = [0.9, 0.1]; // first question keeps order, second swaps
    const { items, key } = buildReview(ollama, mlx, () => flips.shift() ?? 0);
    expect(items[0].answers).toEqual(["Ollama answer 0", "MLX answer 0"]);
    expect(key[0]).toEqual({ id: "q0", first: "ollama", second: "mlx" });
    expect(items[1].answers).toEqual(["MLX answer 1", "Ollama answer 1"]);
    expect(key[1]).toEqual({ id: "q1", first: "mlx", second: "ollama" });
  });

  it("hides stack names from the page until reveal", () => {
    const { items, key } = buildReview(ollama, mlx, () => 0.9);
    const html = buildReviewHtml(items, key, "review-test");
    expect(html).not.toContain("ollama");
    expect(html).not.toContain("mlx");
    expect(html).toContain("Question 0?");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test -- __tests__/benchmark-report.test.ts`
Expected: FAIL with `Cannot find module '../scripts/lib/benchmark-report.js'`.

- [ ] **Step 5: Implement the report logic**

Create `scripts/lib/benchmark-report.ts`:

```ts
// Turns two benchmark files into a comparison report and a blind A/B review page

import type { ChatTimings } from "../../src/services/bench-mode.js";
import type { BenchmarkFile } from "./benchmark-types.js";
import { jaccard, median, percentChange, percentile } from "./stats.js";

export interface MetricDefinition {
  key: keyof ChatTimings;
  label: string;
}

export interface MetricSummary extends MetricDefinition {
  medianA: number | null;
  p90A: number | null;
  medianB: number | null;
  p90B: number | null;
  changePct: number | null;
}

export interface ReviewItem {
  id: string;
  question: string;
  answers: [string, string];
}

export interface ReviewKey {
  id: string;
  first: string;
  second: string;
}

export const METRICS: MetricDefinition[] = [
  { key: "ttftMs", label: "TTFT (ms)" },
  { key: "decodeTokPerSec", label: "Decode (tok/s)" },
  { key: "embedMs", label: "Query embedding (ms)" },
  { key: "retrievalMs", label: "Retrieval (ms)" },
  { key: "totalMs", label: "Total (ms)" },
  { key: "promptTokens", label: "Prompt tokens" },
  { key: "completionTokens", label: "Completion tokens" },
];

export function metricValues(file: BenchmarkFile, key: keyof ChatTimings): number[] {
  return file.questions
    .flatMap((q) => q.runs)
    .flatMap((r) => (r.timings && !r.error ? [r.timings[key]] : []));
}

export function errorCount(file: BenchmarkFile): number {
  return file.questions.flatMap((q) => q.runs).filter((r) => r.error).length;
}

export function summarizeMetrics(a: BenchmarkFile, b: BenchmarkFile): MetricSummary[] {
  return METRICS.map((metric) => {
    const valuesA = metricValues(a, metric.key);
    const valuesB = metricValues(b, metric.key);
    const medianA = median(valuesA);
    const medianB = median(valuesB);
    return {
      ...metric,
      medianA,
      p90A: percentile(valuesA, 90),
      medianB,
      p90B: percentile(valuesB, 90),
      changePct: medianA !== null && medianB !== null ? percentChange(medianA, medianB) : null,
    };
  });
}

export function meanRetrievalOverlap(a: BenchmarkFile, b: BenchmarkFile): number | null {
  const byId = new Map(b.questions.map((q) => [q.id, q]));
  const overlaps = a.questions.flatMap((q) => {
    const firstA = q.runs.find((r) => !r.error);
    const firstB = byId.get(q.id)?.runs.find((r) => !r.error);
    return firstA && firstB ? [jaccard(firstA.chunkIds, firstB.chunkIds)] : [];
  });
  return overlaps.length === 0 ? null : overlaps.reduce((sum, v) => sum + v, 0) / overlaps.length;
}

export function orderByStack(x: BenchmarkFile, y: BenchmarkFile): [BenchmarkFile, BenchmarkFile] {
  return y.stack === "ollama" && x.stack !== "ollama" ? [y, x] : [x, y];
}

function formatNumber(value: number | null): string {
  if (value === null) return "–";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatChange(value: number | null): string {
  if (value === null) return "–";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function buildMarkdownReport(a: BenchmarkFile, b: BenchmarkFile): string {
  const lines: string[] = [
    `# Benchmark: ${a.stack} vs ${b.stack}`,
    "",
    `- ${a.stack}: ${a.environment.chatModel} + ${a.environment.embeddingModel} (${a.environment.stackVersion}), ${a.startedAt}`,
    `- ${b.stack}: ${b.environment.chatModel} + ${b.environment.embeddingModel} (${b.environment.stackVersion}), ${b.startedAt}`,
    `- Machine: ${a.environment.chip}, macOS ${a.environment.macos}; ${a.runsPerQuestion} runs per question`,
    "",
    `| Metric | ${a.stack} median | ${a.stack} p90 | ${b.stack} median | ${b.stack} p90 | ${b.stack} vs ${a.stack} |`,
    "|---|---|---|---|---|---|",
  ];

  for (const m of summarizeMetrics(a, b)) {
    lines.push(`| ${m.label} | ${formatNumber(m.medianA)} | ${formatNumber(m.p90A)} | ${formatNumber(m.medianB)} | ${formatNumber(m.p90B)} | ${formatChange(m.changePct)} |`);
  }

  const overlap = meanRetrievalOverlap(a, b);
  lines.push(
    "",
    `| Peak stack process memory (MB) | ${a.memoryPeak.processMb} | ${b.memoryPeak.processMb} |`,
    `| Peak system used memory (MB) | ${a.memoryPeak.systemUsedMb} | ${b.memoryPeak.systemUsedMb} |`,
    "",
    `Failed runs: ${a.stack} ${errorCount(a)}, ${b.stack} ${errorCount(b)}`,
    "",
    `Retrieval overlap (mean Jaccard of retrieved chunks, first run per question): ${overlap === null ? "–" : overlap.toFixed(2)}`,
    "",
    "Notes: TTFT is measured from the model request, after retrieval. Process memory may undercount GPU buffers on Apple Silicon; compare system used memory as well.",
  );

  return lines.join("\n");
}

export function buildReview(
  a: BenchmarkFile,
  b: BenchmarkFile,
  random: () => number = Math.random
): { items: ReviewItem[]; key: ReviewKey[] } {
  const byId = new Map(b.questions.map((q) => [q.id, q]));
  const items: ReviewItem[] = [];
  const key: ReviewKey[] = [];

  for (const q of a.questions) {
    const answerA = q.runs.find((r) => !r.error)?.answer;
    const answerB = byId.get(q.id)?.runs.find((r) => !r.error)?.answer;
    if (answerA === undefined || answerB === undefined) continue;

    const swap = random() < 0.5;
    items.push({ id: q.id, question: q.question, answers: swap ? [answerB, answerA] : [answerA, answerB] });
    key.push({ id: q.id, first: swap ? b.stack : a.stack, second: swap ? a.stack : b.stack });
  }

  return { items, key };
}

// Embed JSON in a <script> without letting the data close the tag
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildReviewHtml(items: ReviewItem[], key: ReviewKey[], storageId: string): string {
  // The key is base64-encoded so stack names don't appear in the page source before reveal
  const encodedKey = Buffer.from(JSON.stringify(key)).toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Blind A/B review</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0 auto; max-width: 1200px; padding: 24px 16px; background: #f7f7f5; color: #222; }
  .item { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .answers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 800px) { .answers { grid-template-columns: 1fr; } }
  .answer { white-space: pre-wrap; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 12px; font-size: 14px; line-height: 1.45; }
  .choices button { margin: 10px 8px 0 0; padding: 6px 12px; border-radius: 6px; border: 1px solid #bbb; background: #fff; cursor: pointer; }
  .choices button.selected { background: #2d6cdf; color: #fff; border-color: #2d6cdf; }
  #reveal { padding: 10px 18px; font-size: 15px; }
  #results { margin-top: 16px; font-size: 15px; }
</style>
</head>
<body>
<h1>Blind A/B review</h1>
<p>For each question, pick the better answer or a tie. Stacks are revealed once every question is rated.</p>
<div id="items"></div>
<button id="reveal" disabled>Reveal results</button>
<div id="results"></div>
<script>
const ITEMS = ${scriptJson(items)};
const KEY = JSON.parse(atob("${encodedKey}"));
const STORAGE = "${storageId}";
let choices = {};
try { choices = JSON.parse(localStorage.getItem(STORAGE) || "{}"); } catch (e) { choices = {}; }

function save() {
  try { localStorage.setItem(STORAGE, JSON.stringify(choices)); } catch (e) { /* storage unavailable */ }
  document.getElementById("reveal").disabled = ITEMS.some(function (item) { return !choices[item.id]; });
}

function render() {
  const container = document.getElementById("items");
  ITEMS.forEach(function (item, index) {
    const box = document.createElement("div"); box.className = "item";
    const title = document.createElement("h3"); title.textContent = (index + 1) + ". " + item.question; box.appendChild(title);
    const answers = document.createElement("div"); answers.className = "answers";
    item.answers.forEach(function (text, i) {
      const answer = document.createElement("div"); answer.className = "answer";
      const label = document.createElement("strong"); label.textContent = "Answer " + (i + 1) + "\\n\\n";
      answer.appendChild(label); answer.appendChild(document.createTextNode(text));
      answers.appendChild(answer);
    });
    box.appendChild(answers);
    const buttons = document.createElement("div"); buttons.className = "choices";
    [["first", "Answer 1 is better"], ["tie", "Tie"], ["second", "Answer 2 is better"]].forEach(function (option) {
      const button = document.createElement("button");
      button.textContent = option[1];
      if (choices[item.id] === option[0]) button.className = "selected";
      button.addEventListener("click", function () {
        choices[item.id] = option[0];
        Array.from(buttons.children).forEach(function (b) { b.className = ""; });
        button.className = "selected";
        save();
      });
      buttons.appendChild(button);
    });
    box.appendChild(buttons);
    container.appendChild(box);
  });
  save();
}

document.getElementById("reveal").addEventListener("click", function () {
  const tally = { tie: 0 };
  const lines = [];
  KEY.forEach(function (k) {
    const choice = choices[k.id];
    const winner = choice === "tie" ? "tie" : choice === "first" ? k.first : k.second;
    tally[winner] = (tally[winner] || 0) + 1;
    lines.push(k.id + ": answer 1 = " + k.first + ", answer 2 = " + k.second + " -> " + winner);
  });
  const results = document.getElementById("results");
  results.textContent = "";
  const summary = document.createElement("p");
  summary.textContent = Object.keys(tally).map(function (name) { return name + ": " + tally[name]; }).join(" | ");
  const detail = document.createElement("pre"); detail.textContent = lines.join("\\n");
  results.appendChild(summary); results.appendChild(detail);
});

render();
</script>
</body>
</html>
`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- __tests__/benchmark-report.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write the benchmark runner**

Create `scripts/benchmark-stack.ts`:

```ts
// Benchmark the active stack end to end through the running PharmaLLM app
// Usage: npx tsx scripts/benchmark-stack.ts [--runs 3] [--app http://localhost:3000] [--questions bench/questions.json]

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSseLines } from "../src/services/llm-client.js";
import type { ChatTimings } from "../src/services/bench-mode.js";
import type { BenchEnvironment, BenchQuestion, BenchmarkFile, MemoryPeak, QuestionResult, RunResult } from "./lib/benchmark-types.js";

interface Options {
  runs: number;
  appUrl: string;
  questionsPath: string;
}

interface ChatEvent {
  token?: string;
  error?: string;
  done?: boolean;
  stack?: string;
  timings?: ChatTimings;
  chunkIds?: string[];
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    runs: Number(value("--runs") ?? 3),
    appUrl: value("--app") ?? "http://localhost:3000",
    questionsPath: value("--questions") ?? join(process.cwd(), "bench", "questions.json"),
  };
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

// Stack processes: Ollama loads models in "ollama runner" children; MLX runs two Python servers
function stackPatterns(stack: string): string[] {
  return stack === "mlx" ? ["mlx_lm.server", "mlx-embed-server.py"] : ["ollama serve", "ollama runner"];
}

function sampleMemory(stack: string): MemoryPeak {
  let processKb = 0;
  for (const pattern of stackPatterns(stack)) {
    const pids = run("pgrep", ["-f", pattern]).split("\n").filter((pid) => /^\d+$/.test(pid));
    for (const pid of pids) {
      processKb += Number(run("ps", ["-o", "rss=", "-p", pid])) || 0;
    }
  }

  const vm = run("vm_stat", []);
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label: string): number => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const usedPages = pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");

  return {
    processMb: Math.round(processKb / 1024),
    systemUsedMb: Math.round((usedPages * pageSize) / (1024 * 1024)),
  };
}

async function getJson<T>(url: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const resp = await fetch(url, { method });
  if (!resp.ok) throw new Error(`${method} ${url} failed (${resp.status})`);
  return (await resp.json()) as T;
}

async function ask(appUrl: string, question: string, runNumber: number): Promise<RunResult> {
  const resp = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question, benchmark: true }),
  });
  if (!resp.ok || !resp.body) {
    return { run: runNumber, answer: "", timings: null, chunkIds: [], error: `HTTP ${resp.status}` };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseLines(buffer);
    buffer = parsed.rest;

    for (const data of parsed.events) {
      const event = JSON.parse(data) as ChatEvent;
      if (event.error) {
        return { run: runNumber, answer, timings: null, chunkIds: [], error: event.error };
      }
      if (event.token) answer += event.token;
      if (event.done) {
        return { run: runNumber, answer, timings: event.timings ?? null, chunkIds: event.chunkIds ?? [] };
      }
    }
  }

  return { run: runNumber, answer, timings: null, chunkIds: [], error: "stream ended without a done event" };
}

async function waitForIdle(appUrl: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (true) {
    const status = await getJson<{ runningJobs: string[] }>(`${appUrl}/api/bench/status`);
    if (status.runningJobs.length === 0) return;
    if (Date.now() > deadline) throw new Error(`Background jobs still running: ${status.runningJobs.join(", ")}`);
    console.log(`Waiting for background jobs to finish: ${status.runningJobs.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const questions = JSON.parse(await readFile(options.questionsPath, "utf-8")) as BenchQuestion[];

  const health = await getJson<{ status: string; stack: string }>(`${options.appUrl}/api/health`);
  if (health.status === "unhealthy") throw new Error(`PharmaLLM is unhealthy on the ${health.stack} stack`);
  const models = await getJson<{ chatModel: string; embeddingModel: string }>(`${options.appUrl}/api/chat/models`);
  const stack = health.stack;

  const environment: BenchEnvironment = {
    macos: run("sw_vers", ["-productVersion"]),
    chip: run("sysctl", ["-n", "machdep.cpu.brand_string"]),
    thermal: run("pmset", ["-g", "therm"]),
    stackVersion: stack === "mlx"
      ? run(join(process.cwd(), "python", "mlx-venv", "bin", "python"), [
          "-c",
          "import importlib.metadata as m; print('mlx', m.version('mlx'), 'mlx-lm', m.version('mlx-lm'))",
        ])
      : run("ollama", ["--version"]),
    chatModel: models.chatModel,
    embeddingModel: models.embeddingModel,
  };

  await getJson(`${options.appUrl}/api/bench/start`, "POST");
  const memoryPeak: MemoryPeak = { processMb: 0, systemUsedMb: 0 };
  const sampler = setInterval(() => {
    const sample = sampleMemory(stack);
    memoryPeak.processMb = Math.max(memoryPeak.processMb, sample.processMb);
    memoryPeak.systemUsedMb = Math.max(memoryPeak.systemUsedMb, sample.systemUsedMb);
  }, 1000);

  const startedAt = new Date().toISOString();
  const results: QuestionResult[] = [];

  try {
    await waitForIdle(options.appUrl);

    console.log(`Benchmarking ${stack}: ${questions.length} questions × ${options.runs} runs (plus one warm-up)`);
    await ask(options.appUrl, questions[0].question, 0); // warm-up, discarded

    for (const question of questions) {
      const runs: RunResult[] = [];
      for (let n = 1; n <= options.runs; n++) {
        const result = await ask(options.appUrl, question.question, n);
        runs.push(result);
        const summary = result.error
          ? `error: ${result.error}`
          : `TTFT ${result.timings?.ttftMs ?? 0} ms, ${(result.timings?.decodeTokPerSec ?? 0).toFixed(1)} tok/s`;
        console.log(`  ${question.id} run ${n}: ${summary}`);
      }
      results.push({ ...question, runs });
    }
  } finally {
    clearInterval(sampler);
    await getJson(`${options.appUrl}/api/bench/stop`, "POST").catch(() => undefined);
  }

  const output: BenchmarkFile = {
    stack,
    startedAt,
    finishedAt: new Date().toISOString(),
    runsPerQuestion: options.runs,
    environment,
    memoryPeak,
    questions: results,
  };

  const dir = join(process.cwd(), "data", "benchmarks");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stack}-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Saved ${path}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 8: Write the comparison CLI**

Create `scripts/compare-benchmarks.ts`:

```ts
// Compare two benchmark runs and build a blind A/B review page
// Usage: npx tsx scripts/compare-benchmarks.ts data/benchmarks/ollama-….json data/benchmarks/mlx-….json

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkFile } from "./lib/benchmark-types.js";
import { buildMarkdownReport, buildReview, buildReviewHtml, orderByStack } from "./lib/benchmark-report.js";

async function main(): Promise<void> {
  const [pathX, pathY] = process.argv.slice(2);
  if (!pathX || !pathY) {
    console.error("Usage: compare-benchmarks.ts <a.json> <b.json>");
    process.exit(1);
  }

  const x = JSON.parse(await readFile(pathX, "utf-8")) as BenchmarkFile;
  const y = JSON.parse(await readFile(pathY, "utf-8")) as BenchmarkFile;
  const [a, b] = orderByStack(x, y);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(process.cwd(), "data", "benchmarks");

  const report = buildMarkdownReport(a, b);
  const reportPath = join(dir, `compare-${stamp}.md`);
  await writeFile(reportPath, report + "\n", "utf-8");

  const { items, key } = buildReview(a, b);
  const reviewPath = join(dir, `review-${stamp}.html`);
  await writeFile(reviewPath, buildReviewHtml(items, key, `review-${stamp}`), "utf-8");

  console.log(report);
  console.log(`\nReport: ${reportPath}\nBlind review: ${reviewPath} (open it in a browser)`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 9: Typecheck, run all tests**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; all suites pass.

- [ ] **Step 10: Smoke-run the benchmark on one question**

With any stack active (Task 16 left Ollama active):

```bash
node -e 'const q=require("./bench/questions.json"); require("fs").writeFileSync("data/benchmarks/smoke-questions.json", JSON.stringify(q.slice(0,1)))'
npx tsx scripts/benchmark-stack.ts --runs 1 --questions data/benchmarks/smoke-questions.json
curl -s localhost:3000/api/bench/status
```

Expected:
- `Benchmarking ollama: 1 questions × 1 runs (plus one warm-up)`, one `vendor-dell run 1: TTFT … ms, … tok/s` line, and `Saved …/data/benchmarks/ollama-….json`.
- Bench status afterwards: `{"active":false,"runningJobs":[]}`.

Run: `npx tsx scripts/compare-benchmarks.ts data/benchmarks/ollama-*.json data/benchmarks/ollama-*.json`
Expected: a markdown table with `+0.0%` changes and the paths of the report and review page. Delete these smoke files afterwards: `rm data/benchmarks/smoke-questions.json data/benchmarks/ollama-*.json data/benchmarks/compare-*.md data/benchmarks/review-*.html`.

- [ ] **Step 11: Commit**

```bash
git add bench/questions.json scripts/lib/benchmark-types.ts scripts/lib/benchmark-report.ts scripts/benchmark-stack.ts scripts/compare-benchmarks.ts __tests__/benchmark-report.test.ts
git commit -m "feat: add stack benchmark runner, comparison report and blind review page

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Documentation and first full comparison

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md` (append results)

- [ ] **Step 1: Update the Quick Start in `README.md`**

Replace the code block under `## Quick Start` (from ```` ```bash ```` through the closing fence after `# --> Health:    http://localhost:3000/api/health`) with:

````markdown
```bash
# 1. Install Ollama and Node dependencies
brew install ollama && brew services start ollama
git clone https://github.com/sebdallais-git/PharmaCyberLLM.git
cd PharmaCyberLLM
npm install

# 2. Download both LLM stacks (Ollama + MLX, about 33 GB) and build the Ollama indexes
scripts/switch-stack.sh prepare

# 3. Launch on the active stack (Ollama by default)
npm run dev

# --> Chat:      http://localhost:3000
# --> Dashboard: http://localhost:3000/dashboard
# --> Health:    http://localhost:3000/api/health
```
````

- [ ] **Step 2: Add a stack section to `README.md`**

Insert directly above `## How It Works`:

````markdown
## LLM Stacks (Ollama / MLX)

PharmaLLM runs every local model call (chat and embeddings) on exactly one of two stacks. Both use the same models, so the stacks can be compared fairly.

| | Ollama stack | MLX stack |
|---|---|---|
| Chat | `qwen3.8-pharma` (Qwen3.8 27B Q4_K_M, 16k context) | `mlx-community/Qwen3.8-27B-4bit` via `mlx_lm.server` (:8080) |
| Embeddings | `qwen3-embedding:0.6b-q8_0` | `mlx-community/Qwen3-Embedding-0.6B-8bit` via `python/mlx-embed-server.py` (:8081) |
| Search indexes | `knowledge_base_ollama`, `knowledge/.index.ollama.json` | `knowledge_base_mlx`, `knowledge/.index.mlx.json` |

Only one stack runs at a time, and the app never falls back to the other one.

```bash
scripts/switch-stack.sh mlx      # stop Ollama, start MLX, restart PharmaLLM (rolls back on failure)
scripts/switch-stack.sh ollama   # and back
scripts/switch-stack.sh status   # ports and index counts for both stacks
```

The first switch to a stack builds its indexes from `knowledge/` and `data/raw_documents/`, which takes a while. Rebuild them later with `LLM_PROVIDER=<stack> npx tsx scripts/reindex-stack.ts` (app stopped) or `POST /api/knowledge/reindex` (app running).

### Benchmarking the stacks

```bash
scripts/switch-stack.sh ollama && npx tsx scripts/benchmark-stack.ts
scripts/switch-stack.sh mlx    && npx tsx scripts/benchmark-stack.ts
npx tsx scripts/compare-benchmarks.ts data/benchmarks/ollama-<time>.json data/benchmarks/mlx-<time>.json
```

The benchmark sends the questions in `bench/questions.json` through `/api/chat` in benchmark mode (temperature 0, no web search, background LLM jobs paused), 3 runs each. The comparison reports median and p90 for TTFT, decode speed, embedding and retrieval time, peak memory and retrieval overlap. It also writes a blind A/B review page where you rate answers before the stacks are revealed.
````

In the Table of Contents under `## Table of Contents`, add `- [LLM Stacks (Ollama / MLX)](#llm-stacks-ollama--mlx)` directly above the `How It Works` entry.

- [ ] **Step 3: Update the API reference and environment variables**

In `### Dashboard & Health`, replace the row:

```markdown
| `/api/health` | GET | Service health (Ollama, ChromaDB, SearXNG, SQLite, Neo4j) |
```

with:

```markdown
| `/api/health` | GET | Health of the active stack (`llm_chat`, `llm_embed`, `search_index`) plus ChromaDB, SearXNG, Neo4j, SQLite |
```

Insert above `### Agent`:

```markdown
### Stack & Benchmark
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat/models` | GET | Active stack, its chat and embedding models, available models |
| `/api/llm/complete` | POST | `{ prompt }` → `{ response }` on the active stack (used by N8N) |
| `/api/bench/start` | POST | Pause background LLM jobs for a benchmark |
| `/api/bench/stop` | POST | Resume background LLM jobs |
| `/api/bench/status` | GET | Benchmark flag and running background jobs |

```

In `## Environment Variables`, replace the two rows:

```markdown
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model |
```

with:

```markdown
| `LLM_PROVIDER` | `ollama` | Active stack (`ollama` or `mlx`); set by `scripts/switch-stack.sh` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama stack endpoint |
| `MLX_CHAT_URL` | `http://localhost:8080` | MLX chat server endpoint |
| `MLX_EMBED_URL` | `http://localhost:8081` | MLX embedding server endpoint |
| `MLX_PYTHON` | `python3` | Python used to create `python/mlx-venv` |
```

Run: `grep -n "mistral-small\|nomic-embed-text\|ollama serve" README.md || echo "clean"`
Expected: `clean`. If older sections (for example the architecture diagram or tech stack table) still mention these, update them to the Qwen3.8 models and the stack switch in the same style.

- [ ] **Step 4: Commit the docs**

```bash
git add README.md
git commit -m "docs: document the Ollama/MLX stack switch and benchmarks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Run the full comparison**

Tell the user this takes roughly 1–2 hours per stack (23 questions × 3 runs plus a warm-up) and that PharmaLLM stays usable, but slower, while it runs. Close other heavy apps first so memory numbers are comparable.

```bash
scripts/switch-stack.sh ollama && npx tsx scripts/benchmark-stack.ts
scripts/switch-stack.sh mlx && npx tsx scripts/benchmark-stack.ts
npx tsx scripts/compare-benchmarks.ts data/benchmarks/ollama-*.json data/benchmarks/mlx-*.json
```

Expected: two `Saved data/benchmarks/<stack>-….json` lines, then the markdown report with every metric filled in, `Failed runs: ollama 0, mlx 0`, a retrieval overlap value, and the paths of the report and review page.

If a run reports failures, read the `error` fields in the JSON before comparing; don't compare runs with failures.

- [ ] **Step 6: Final verification**

Run: `npm run typecheck && npm run typecheck:tests && npm run test`
Expected: exit 0; all suites pass.

Run: `scripts/switch-stack.sh status`
Expected: the active stack's ports up, the other stack's down, both stacks' indexes `ok`.

- [ ] **Step 7: Record results and hand over**

Append a "First comparison" section to `docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md` containing the markdown report. Give the user the report path and the blind review page path (`data/benchmarks/review-….html`) to rate answers.

```bash
git add docs/superpowers/plans/2026-09-16-ollama-mlx-stack-switch-verification.md
git commit -m "docs: record first Ollama vs MLX benchmark results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

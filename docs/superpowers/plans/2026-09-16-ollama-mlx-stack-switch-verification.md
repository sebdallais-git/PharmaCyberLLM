# Ollama/MLX Stack Switch — Task 0 Verification Spike

Date: 2026-09-16
Branch: `feature/ollama-mlx-stack-switch`
Machine: Mac mini M4 Pro, 48 GB (macOS 26.4, arm64)

Summary: all expectations from the Task 0 brief were met. Ollama required an
upgrade (0.17.6 → 0.34.0) before the model pulls would succeed. The MLX
virtual environment already existed with working versions on the default
Python 3.14 (`MLX_PYTHON` override is NOT required). Both stacks were
exercised end-to-end: Ollama's OpenAI-compatible chat/embeddings endpoints,
and MLX's `mlx_lm.server` OpenAI-compatible chat endpoint with Ollama fully
stopped. Ollama was restarted and confirmed healthy before finishing.

## Step 1: Resolve uncommitted work

Resolved by the controller before this spike started: the user chose to
**commit** the prior work (commit `593b73b`, "feat: save in-progress work
before the Ollama/MLX stack switch").

```
$ git status --short
?? .claude/
?? .firecrawl/
?? certs/
```
(Only untracked directories explicitly excluded from this task remain; no
tracked-file modifications outstanding.)

```
$ git branch --show-current
feature/ollama-mlx-stack-switch
```

**Pass** — matches expected branch.

## Step 2: User notified

The controller told the user Ollama would be stopped briefly during the
spike (Steps 5–7 of the brief / Step 7 of this run). Acknowledged, no
command run.

## Step 3: Pull the Ollama models

Initial pull failed with a message that the model requires a newer version
of Ollama. The controller ran:

```
brew upgrade ollama   # 0.17.6 -> 0.34.0
brew services restart ollama   # service label: sh.brew.ollama
```

Both models were then pulled successfully (`success`). Verified in this
session:

```
$ ollama --version
ollama version is 0.34.0

$ ollama list | grep qwen3
qwen3-embedding:0.6b-q8_0    ac6da0dfba84    639 MB    3 minutes ago
qwen3.8:27b-q4_K_M           25b843619e94    17 GB     3 minutes ago
```

**Pass** — both models present, version confirms the upgrade took effect.

## Step 4: Context-length model and Ollama's OpenAI API

```
$ mkdir -p ollama
$ cat > ollama/qwen3.8-pharma.Modelfile <<'EOF'
# Qwen3.8 27B (Q4_K_M) with the 16k context PharmaLLM uses; Ollama's OpenAI API can't set num_ctx per request
FROM qwen3.8:27b-q4_K_M
PARAMETER num_ctx 16384
EOF
$ ollama create qwen3.8-pharma -f ollama/qwen3.8-pharma.Modelfile
...
success

$ ollama show qwen3.8-pharma --parameters
repeat_penalty                 1
temperature                    1
top_k                          20
top_p                          0.95
min_p                          0
num_ctx                        16384
presence_penalty               0
```

**Pass** — `num_ctx 16384` present.

Chat completion (streaming, thinking disabled, usage requested):

```
$ curl -sN http://localhost:11434/v1/chat/completions ... | tail -n 5
data: {... "delta":{"content":"ic"} ...}
data: {... "delta":{"content":"**"} ...}
data: {... "delta":{},"finish_reason":"length"}
data: {... "choices":[],"usage":{"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens":40,"total_tokens":60}}
data: [DONE]
```

Streamed `delta.content` tokens only (e.g. "Ozempic** (for..."), no
`<think>` text, no `reasoning` deltas. Final chunk carried a `usage` object
with `prompt_tokens`/`completion_tokens`, followed by `data: [DONE]`.

**Pass** — thinking off, usage chunk present.

```
$ ollama ps
NAME                     ID              SIZE     PROCESSOR    CONTEXT    UNTIL
qwen3.8-pharma:latest    c11129e70ad5    17 GB    100% GPU     16384      4 minutes from now
```

**Pass** — CONTEXT is `16384`.

Embeddings:

```
$ curl -s http://localhost:11434/v1/embeddings ... | python3 -c '...len(embedding)...'
1024
```

**Pass** — embedding length is `1024`.

## Step 5: MLX virtual environment

Already created by the controller prior to this spike (`python/mlx-venv`).
Verified in this session with the brief's version command:

```
$ python/mlx-venv/bin/python -c "import importlib.metadata as m; print(m.version('mlx'), m.version('mlx-lm'))"
0.32.2 0.31.3
```

mlx-lm is `0.31.3` as expected, on the default `python3` (Python 3.14).
**`MLX_PYTHON` is NOT required.**

**Pass**.

## Step 6: MLX models downloaded

Already downloaded by the controller prior to this spike. Verified:

```
$ ls ~/.cache/huggingface/hub | grep -E 'Qwen3.8-27B-4bit|Qwen3-Embedding-0.6B-8bit'
models--mlx-community--Qwen3-Embedding-0.6B-8bit
models--mlx-community--Qwen3.8-27B-4bit
```

**Pass** — both directories present.

## Step 7: mlx_lm.server with Ollama stopped

```
$ brew services stop ollama
Stopping `ollama`... (might take a while)
==> Successfully stopped `ollama` (label: sh.brew.ollama)
$ sleep 3; nc -z localhost 11434 && echo "STILL UP" || echo "ollama down"
ollama down
```

**Pass** — Ollama confirmed down before starting MLX.

```
$ python/mlx-venv/bin/mlx_lm.server --model mlx-community/Qwen3.8-27B-4bit --host 127.0.0.1 --port 8080 > <scratchpad>/mlx-spike.log 2>&1 &
$ until curl -sf http://localhost:8080/v1/models > /dev/null; do sleep 2; done
```

Server log excerpt (no `qwen3_5` architecture error; model fetched from
local HF cache and server started cleanly):

```
Fetching 13 files: 100%|██████████| 13/13 [00:00<00:00, 3326.38it/s]
.../mlx_lm/server.py:1723: UserWarning: mlx_lm.server is not recommended for production as it only implements basic security checks.
2026-09-16 18:03:26,236 - INFO - Starting httpd at 127.0.0.1 on port 8080...
127.0.0.1 - - [16/Sep/2026 18:03:31] "GET /v1/models HTTP/1.1" 200 -
```

`/v1/models` response listed both MLX models:
```
{"object": "list", "data": [
  {"id": "mlx-community/Qwen3-Embedding-0.6B-8bit", ...},
  {"id": "mlx-community/Qwen3.8-27B-4bit", ...}
]}
```

**Pass** — model loads, no architecture error.

Chat completion (streaming, thinking disabled via `chat_template_kwargs`,
usage requested):

```
$ curl -sN http://localhost:8080/v1/chat/completions ... | tail -n 5
data: {... "delta": {"role": "assistant", "content": "**"}}
data: {... "finish_reason": "length", "delta": {"role": "assistant"}}
data: {"object": "chat.completion", ..., "choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 40, "total_tokens": 60, "prompt_tokens_details": {"cached_tokens": 0}}}
data: [DONE]
```

Streamed content only (e.g. "Ozempic** ..."), no `<think>` text. Final
chunk carried `usage` before `data: [DONE]`.

**Pass** — thinking off, usage chunk present.

```
$ kill "$(cat <scratchpad>/mlx-spike.pid)"
```
Confirmed the process exited (no longer alive on follow-up `kill -0` check).

## Step 8: Restart Ollama

```
$ brew services start ollama
==> Successfully started `ollama` (label: sh.brew.ollama)
$ until curl -sf http://localhost:11434/v1/models > /dev/null; do sleep 1; done; echo "ollama up"
ollama up
```

Ollama answered `/v1/models` almost immediately after the service restart
(waited ~1s). `ollama --version` still reports `0.34.0`; `ollama ps` shows
no models currently loaded (fresh restart, none requested yet).

**Pass** — Ollama is back up.

## Versions and environment summary

| Item | Value |
| --- | --- |
| `ollama --version` | 0.34.0 (upgraded from 0.17.6 during Step 3) |
| Homebrew service label | `sh.brew.ollama` |
| `mlx` version | 0.32.2 |
| `mlx-lm` version | 0.31.3 |
| Python used for MLX venv | default `python3` (3.14) |
| `MLX_PYTHON` override needed? | No |

## Overall result

All steps (1–8) passed with no deviations from expected behavior. No
workarounds beyond the brief's own documented fallback (the Homebrew
upgrade in Step 3, which was itself expected/prescribed by the brief) were
needed. Proceeding to Step 10 (commit).

## Bring-up (2026-09-16)

### Index builds

| Stack | In-memory chunks | ChromaDB chunks | Raw documents skipped | Build time |
|---|---|---|---|---|
| Ollama (`qwen3-embedding:0.6b-q8_0`) | 7,614 | 7,277 upserted (7,262 unique) | 0 | 935.6 s (15.6 min) |
| MLX (`Qwen3-Embedding-0.6B-8bit`) | 7,617 | 7,280 | 0 | 697.9 s (11.6 min) |

Sources: `data/logs/reindex-ollama.log`, `data/logs/reindex-mlx.log`. The MLX build included 3 more raw documents (news saved by the app between builds). The partial Ollama index built earlier by the long-running dev server was moved aside before the rebuild and deleted afterwards.

### Embedding smoke tests

- Ollama (`:11434`): `dims=1024 relevant=0.798 unrelated=0.191 determinism=1.000000` → PASS
- MLX (`:8081`): `dims=1024 relevant=0.799 unrelated=0.194 determinism=1.000000` → PASS

### Cross-stack embedding parity

`ollama vs mlx: mean cosine 0.9986, min 0.9875 over 20 texts` → PASS (threshold 0.98)

### Benchmark-mode chat (same question, via `/api/chat`)

| Stack | Run | TTFT | Decode | Prompt / completion tokens | Total |
|---|---|---|---|---|---|
| Ollama | 1st | 21,765 ms | 12.3 tok/s | 2,320 / 912 | 96.4 s |
| MLX | 1st | 55,551 ms | 12.8 tok/s | 2,320 / 512 | 95.6 s |
| MLX | repeat, same question | 611 ms | 12.9 tok/s | 2,320 / 512 | 40.4 s |
| MLX | new question | 54,443 ms | 7.6 tok/s | 2,413 / 512 | 121.9 s |

Findings that affect the benchmark (to resolve before Task 18):
1. **`mlx_lm.server` caps completions at 512 tokens by default**; Ollama produced 912. The client sends no `max_tokens`, so MLX answers are truncated. Both stacks must receive the same explicit `max_tokens`.
2. **Prompt caching**: repeating a question gives a near-instant TTFT (611 ms) because the server reuses the cached prompt prefix. Runs 2–3 of a question measure cached performance; the first run of each question must be reported separately.
3. Early signal: MLX prompt processing was slower than Ollama (~43–44 tok/s vs ~107 tok/s) in these first samples.

### Switching and rollback

- `switch-stack.sh mlx`: Ollama stopped (`:11434` closed), MLX servers up on `:8080`/`:8081`, index built, app healthy on `mlx`.
- `switch-stack.sh ollama`: MLX servers stopped, existing Ollama indexes reused ("Indexes for ollama are ready"), app healthy on `ollama`.
- Rollback test: a foreign `python3 -m http.server 8081` blocked the MLX embedding port; `switch-stack.sh mlx` exited 1 after "MLX embedding server did not become ready", rolled back ("Port 8081 is used by another program … leaving it alone"), and ended with only Ollama running and the app healthy. The blocker was left untouched by the script and stopped manually afterwards. Note: the up-front "cannot start MLX" foreign-port check did not trigger; the switch waited for the readiness timeout instead.

Final state: active stack `ollama`, app healthy.

## First comparison (2026-09-16)

Settings (user decisions during execution): 23 questions, one cold run each after a warm-up question outside the set, temperature 0, no web search, max_tokens 1024 on both stacks, background LLM jobs paused.

### Benchmark: ollama vs mlx

- ollama: qwen3.8-pharma + qwen3-embedding:0.6b-q8_0 (ollama version is 0.34.0), 2026-09-16T17:50:13.074Z
- mlx: mlx-community/Qwen3.8-27B-4bit + mlx-community/Qwen3-Embedding-0.6B-8bit (mlx 0.32.2 mlx-lm 0.31.3), 2026-09-16T18:27:51.432Z
- Machine: Apple M4 Pro, macOS 26.4; 1 runs per question

| Metric | ollama median | ollama p90 | mlx median | mlx p90 | mlx vs ollama |
|---|---|---|---|---|---|
| TTFT (ms) | 19067.5 | 22555.7 | 18528.6 | 21231.7 | -2.8% |
| Decode (tok/s) | 12.4 | 12.5 | 13.0 | 13.1 | +4.9% |
| Query embedding (ms) | 30 | 33 | 18 | 20 | -40.0% |
| Retrieval (ms) | 80 | 118 | 42 | 47 | -47.5% |
| Total (ms) | 99612 | 104982 | 93838 | 97848 | -5.8% |
| Prompt tokens | 2171 | 2539 | 2171 | 2539 | 0.0% |
| Completion tokens | 1024 | 1024 | 1024 | 1024 | 0.0% |

| Memory | ollama | mlx | mlx vs ollama |
|---|---|---|---|
| Peak stack process memory (MB) | 59 | 15979 | +26983.1% |
| Peak system used memory (MB) | 39958 | 37338 | -6.6% |

Failed runs: ollama 0, mlx 0

Retrieval overlap (mean Jaccard of retrieved chunks, first run per question): 0.91

Notes: TTFT is measured from the model request, after retrieval. Process memory may undercount GPU buffers on Apple Silicon; compare system used memory as well.

### Corrections and observations

- **Ollama peak process memory (59 MB) is invalid.** Ollama 0.34.0 runs models in `libexec/lib/ollama/llama-server` child processes, which the sampler's `ollama serve` / `ollama runner` patterns miss. Measured directly after the run (resident memory while loaded): chat model runner 17,576 MB + embedding runner 2,780 MB ≈ **20.4 GB** for Ollama, versus **16.0 GB** peak for MLX. The system-wide peak (independent of process names) is valid: MLX −6.6%.
- **Answer length:** the 1024-token cap was reached by 15/23 Ollama answers and 13/23 MLX answers, so most benchmark answers are truncated on both stacks. The comparison is fair (same cap) but the blind review compares truncated answers.
- **Prompt processing (derived):** median prompt tokens per second of TTFT ≈ 112 (Ollama) vs 119 (MLX). The slow MLX TTFT seen during bring-up (~55 s) did not reproduce; it was a first-use/warm-up artifact.
- **Retrieval:** mean overlap of retrieved chunks 0.91 between stacks, so answers were built from nearly the same evidence; MLX query embedding and retrieval were faster (18 vs 30 ms, 42 vs 80 ms), negligible next to generation time.
- Raw results: `data/benchmarks/ollama-2026-09-16T17-50-13-074Z.json`, `data/benchmarks/mlx-2026-09-16T18-27-51-432Z.json`. Blind review page: `data/benchmarks/review-2026-09-16T19-02-48-804Z.html`.

### Final verification

`npm run typecheck`, `npm run typecheck:tests`: clean. `npm run test`: 16 suites, 87 tests passed. `switch-stack.sh status`: active stack `ollama`, app up; both stacks' indexes ok (ollama 7,617 / 7,270 chunks, mlx 7,624 / 7,267).

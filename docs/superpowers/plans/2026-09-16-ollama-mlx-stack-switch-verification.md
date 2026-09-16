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

# oMLX Stack Verification

## Task 0: verification spike (2026-09-18)

Run on the Mac mini (M4 Pro, 48 GB) with the MLX stack active. Only the MLX **chat** server (:8080) was stopped for the spike; the MLX **embedding** server (:8081) stayed up so the reference vector could be recorded against it. oMLX ran from a scratch venv on :8090.

### Version

```
commit cbc1a80397796d91aa64a58c8562d5138ae125e3 (2026-09-18)
omlx --version -> 0.7.0.dev3
```

`OMLX_VERSION` for the plan: `cbc1a80`.

### Model discovery

With `--model-dir ~/.cache/huggingface/hub`, oMLX found both models already on disk, so nothing is downloaded twice:

```
models: ['mlx-community--Qwen3-Embedding-0.6B-8bit', 'mlx-community--Qwen3.8-27B-4bit']
```

These are the ids the stack config must use (double dashes, not slashes).

### Cache limits

Richer than the plan assumed. `omlx serve --help` offers:

```
--paged-ssd-cache-dir PAGED_SSD_CACHE_DIR      directory for the paged SSD cache
--paged-ssd-cache-max-size PAGED_SSD_CACHE_MAX_SIZE
--hot-cache-max-size HOT_CACHE_MAX_SIZE
--memory-guard-gb MEMORY_GUARD_GB              memory guard ceiling
--no-cache                                     disable caching entirely
```

So the disk budget is a real flag, not a settings-file guess. Task 2 should pass `--paged-ssd-cache-max-size` (and may pass `--memory-guard-gb`) rather than leaving the cache unbounded.

### Thinking switch

```
without chat_template_kwargs: content '4' | reasoning field present: True
with    chat_template_kwargs: content '4' | reasoning field present: False
```

oMLX honours `chat_template_kwargs: { enable_thinking: false }`, so the omlx stack uses the same `chatExtraBody` as the mlx stack.

### Embedding reference

```
dims 1024 1024   cosine 1.0
```

`__tests__/fixtures/embedding-reference.json` holds the probe sentence and the 1024-float vector from the MLX embedding server (20,680 bytes). The parity guard in Task 3 compares against it.

### Cache size after the spike

`~/.omlx` reached 4.3 GB after the earlier trial plus this spike, with the default unbounded cache — which is why Task 2 sets an explicit ceiling.

---

## Live verification (2026-09-18, after the branch merged as `ff273ee`)

Mac mini M4 Pro, 48 GB. Steps 1, 2 and the refusal checks ran unattended; the Telegram and
UI steps need the owner at the keyboard and are still outstanding, as is the three-stack
benchmark.

### Install: the version trap

`pip install -e python/omlx-src` **fails on this machine's default interpreter**:

```
ERROR: Package 'omlx' requires a different Python: 3.14.7 not in '<3.14,>=3.11'
```

`python3` here is 3.14.7 and so is `python/mlx-venv` — MLX is happy on 3.14, oMLX is not.
The venv had to be built with `~/.local/bin/python3.11` (3.11.16). `prepare` used
`$MLX_PYTHON` for the oMLX venv and would have hit the same wall after a 213 MB clone, so
it now uses its own `OMLX_PYTHON` (default `python3.11`) and refuses early with a message
naming the required range. Installed: `omlx 0.7.0.dev3`, source pinned at `cbc1a80`.

### Step 1 — `scripts/switch-stack.sh omlx`

```
[switch-stack] ChromaDB already running on port 8100
[switch-stack] Switching: mlx -> omlx
[switch-stack] Embedding parity ok (cosine=1.0)
[switch-stack] Warming up omlx...
[switch-stack] Indexes for omlx are ready
[switch-stack] PharmaLLM is up on the omlx stack
[switch-stack] Active stack: omlx
```

Two lines carry the whole design. **`Embedding parity ok (cosine=1.0)`** — the guard ran
against the committed reference vector before the app came back. **`Indexes for omlx are
ready`** — no rebuild. Before the final review's F1 fix this read "Building indexes for
omlx (re-embeds the whole knowledge base)" and would have deleted the live
`knowledge_base_mlx` collection; that fix is what this line proves in the real switch path,
not just in a test.

`/api/health` → `omlx healthy`. `/api/stack/status`:

```json
{"active":"omlx","stacks":["ollama","mlx","omlx"],"telegram_configured":false,"pending":null,
 "progress":{"phase":"ready","target":"omlx","previous":"mlx","startedAt":1789745607000,"finishedAt":1789745624890}}
```

17.9 s end to end, so the UI line would read `OMLX stack ready (18 s)`.

### Step 2 — retrieval against the shared index

Same query on both stacks, MLX first and oMLX after the switch:

| | sources returned |
|---|---|
| mlx (before) | `news-2022-07-08`, `vendor-dell-cyber-recovery.md`, `novartis cyber resilience v2.docx` |
| omlx (after) | `news-2022-07-08`, `vendor-dell-cyber-recovery.md`, `novartis cyber resilience v2.docx` |

Identical, off one index, with no rebuild. `reindex-stack.ts --status` agrees: omlx and mlx
both report 7743 in-memory and 7380 ChromaDB chunks; ollama reads its own 7798 / 7372.

Generation through the token-protected gateway on oMLX: `finish_reason: stop`, 33 completion
tokens, 2.9 s.

### Refusal checks (step 6, partly)

| Request | Result |
|---|---|
| `{"stack":"gpt5"}` | `400 Unknown stack (expected ollama, mlx or omlx)` |
| `{"stack":"mlx"}`, no Telegram credentials | `409 telegram_unconfigured` |
| `{"stack":"omlx"}` (already active), no credentials | `409 telegram_unconfigured` |

The credential check fails closed **before** every other refusal, so with no confirmation
channel configured a switch cannot be requested at all — the spec's "a switch can never
happen without approval", confirmed from the outside. `already_active` could not be reached
for the same reason; it stays covered by unit tests until the credentials are stored.

### Resources

`~/.omlx` 4.3 GB (unchanged from the trial — this switch restored from cache rather than
growing it). oMLX process RSS 16.5 GB; system memory 91% free.

### Still outstanding

- Steps 3-6: store the Telegram credentials, then a UI switch end to end, the 5-minute
  revert path, and the `already_active` refusal.
- Step 7: benchmark all three stacks and fill in the README's third column, which Task 9
  deliberately left empty rather than invent.

### Step 7 — all three stacks benchmarked (2026-09-19)

Same machine, same day, same index, switched between runs, 23 questions each through
`POST /api/chat`:

| Metric (median) | Ollama | MLX | oMLX |
|---|---:|---:|---:|
| Time to first token | 19.1 s | 18.4 s | **17.5 s** |
| Decode | 12.4 tok/s | 13.2 tok/s | **15.2 tok/s** |
| Total per answer | 99.6 s | 92.3 s | **82.5 s** |
| Query embedding | 31 ms | **19 ms** | 21 ms |
| Retrieval | 76 ms | **44 ms** | 68 ms |
| Peak system memory | 42,845 MB | **37,409 MB** | 41,009 MB |
| Model process memory | 28,459 MB | **16,184 MB** | 17,119 MB |
| Hit the 1024-token cap | 15 / 23 | 11 / 23 | 10 / 23 |
| Failed runs | 0 / 23 | 0 / 23 | 0 / 23 |

oMLX leads generation (+23% decode over Ollama, +15% over MLX, −17% total answer time
against Ollama). MLX keeps the lowest memory and the fastest retrieval — its embedding
server is a separate process, where oMLX shares one process with chat.

Raw files: `data/benchmarks/{ollama,mlx,omlx}-2026-09-19T*.json`.

### Cost incurred: two Hermes cron jobs failed

Benchmark mode makes `/v1` return `503`, and Hermes runs entirely through `/v1`. Both of
that morning's scheduled jobs died against it:

```
pharmallm-news-digest     06:32:53  error  HTTP 503: Benchmark in progress
pharmallm-gap-resolution  07:00:55  error  HTTP 503: Benchmark in progress
```

The second was avoidable — the oMLX run was still finishing at 07:04 and the collision with
the 07:00 job had already been predicted. The later MLX and Ollama runs were scheduled into
the 07:10–08:55 gap and finished at 08:29, clear of the 09:00 health-watch.

**Lesson for anyone benchmarking this machine:** read `~/.hermes/cron/jobs.json` for
`next_run_at` before starting. A full three-stack run needs about 100 minutes including
switches, and the agent is blind for all of it.

### Two bugs the live run found that the test suite could not

1. **oMLX was a one-way trap.** `is_project_pid` identified our processes by matching the
   project path in their command line, but oMLX depends on `setproctitle` and runs as plain
   `omlx-server`. The script disowned its own server: it refused to reuse a running oMLX
   (`Port 8090 is used by another program`) *and* would have refused to stop it. The app
   was left down after a failed switch. Fixed in `179ec91` by checking recorded pid files
   first. Tests could not have caught it — they stub the binary, and a stub keeps the
   project path in its command line.
2. **The oMLX venv could not be built by `prepare`.** oMLX pins `>=3.11,<3.14`; this
   machine's `python3` and `python/mlx-venv` are both 3.14.7. `prepare` used `$MLX_PYTHON`
   and failed after a 213 MB clone. Fixed in `0bf7bb4` with its own `OMLX_PYTHON`.

### Still outstanding

The UI switch confirmed from Telegram (steps 4 and 5). The message arrives and the 5-minute
expiry was observed working, but tapping the link failed with "a server with the specified
hostname could not be found" — the receiving device was not resolving Tailscale MagicDNS.
Confirmation links were repointed at the Tailscale IP (`https://100.69.110.112:3443`), which
needs no MagicDNS; retest pending.

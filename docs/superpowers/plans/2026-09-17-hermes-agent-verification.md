# Hermes Agent Integration — Verification

## Source verification

Before planning, Hermes Agent source was read at commit `228022ef5b209cb0a3d739394edddf887e1db0f6` (version 0.21.3) without installing anything. The findings are recorded in the spec's "Amendments from source verification" section (`docs/superpowers/specs/2026-09-17-hermes-agent-integration-design.md`). The one that changed the code: the Streamable HTTP MCP client's 300 s read timeout, which led to keepalive notifications in `pharmallm-mcp`.

## 64K context (Task 7, 2026-09-17, Apple M4 Pro, 48 GB)

### Ollama

`scripts/switch-stack.sh ollama` recreated the model from the Modelfile, reusing the pulled weights with no download:

```
using existing layer sha256:4c6a8e84…
creating new layer sha256:85d75956…
writing manifest
success
[switch-stack] Warming up ollama...
[switch-stack] PharmaLLM is up on the ollama stack
num_ctx                        65536
NAME                         ID              SIZE      PROCESSOR    CONTEXT
qwen3-embedding:0.6b-q8_0    ac6da0dfba84    4.0 GB    100% GPU     32768
qwen3.8-pharma:latest        6674d043f8a8    19 GB     100% GPU     65536
```

The `ollama create` progress lines (stderr) show in the switch output; `ensure_ollama_ctx` only silences stdout. A later switch logs `qwen3.8-pharma context is 65536` and skips the recreate.

Probe: a ≈16.7K-token system prompt through `/v1` (streamed, max 48 tokens), sent cold and then warm (same prefix, new question):

```
PhysMem: 47G used (26G wired, 1239M compressor), 309M unused.
{"prompt_tokens": 16716, "ttft_s": 156.3, "decode_tok_s": 11.3, "total_s": 159.2}
{"prompt_tokens": 16715, "ttft_s": 5.8, "decode_tok_s": 11.6, "total_s": 6.8}
PhysMem: 47G used (26G wired, 1236M compressor), 274M unused.
vm.swapusage: total = 7168.00M  used = 6168.75M  free = 999.25M
```

Memory:
- **Largest processes by RSS:** Ollama chat runner 20.7 GB, embedding runner 3.0 GB, Docker VM 1.0 GB (Neo4j 0.54 GiB, SearXNG 0.16 GiB).
- **Pressure:** `memory_pressure` reports 41% free and `vm.memory_pressure` 0 (normal).
- **Swap:** the swap figure accumulated from earlier switches and benchmarks. It was not caused by this probe.

### MLX

```
--prompt-cache-bytes 8589934592
PhysMem: 47G used (3031M wired, 2651M compressor), 636M unused.
{"prompt_tokens": 16716, "ttft_s": 141.2, "decode_tok_s": 11.5, "total_s": 143.9}
{"prompt_tokens": 16715, "ttft_s": 0.8, "decode_tok_s": 12.4, "total_s": 1.0}
PhysMem: 47G used (26G wired, 2390M compressor), 93M unused.
System-wide memory free percentage: 40%
mlx chat RSS 12.1 GB
```

Back on Ollama afterwards: `ollama healthy`, 40% memory free.

### Summary

| | Ollama | MLX |
|---|---|---|
| Cold TTFT, 16.7K-token prompt | 156.3 s (≈107 tok/s prefill) | 141.2 s (≈118 tok/s prefill) |
| Warm TTFT, same prefix | 5.8 s | 0.8 s |
| Decode | 11.3–11.6 tok/s | 11.5–12.4 tok/s |
| Memory pressure | normal, 41% free | normal, 40% free |

The spec estimated a first reply of 90–130 s for a 10–15K prompt; a 16.7K prompt measures 141–156 s, which fits that estimate. Warm steps are much faster than estimated, especially on MLX.

## Hermes install and live verification (Task 8, 2026-09-17)

Installer: pinned commit `228022ef…`, sha256 `2de7a1d60a7c0edf685d3b7b875b93a99c8006473a55218688a0075a88637045`, reviewed with the user and run with `--skip-setup --skip-browser --skip-computer-use --non-interactive`. Result: Hermes Agent v0.21.3, Python 3.11.16, existing Node 22.22 reused; Playwright, browser-use and the third-party cua-driver skipped; no gateway autostart.

### Setup

`scripts/hermes-setup.sh all` installed config.yaml and SOUL.md, filled `~/.hermes/.env` (mode 600) and created the four cron jobs. The user typed the Telegram secrets into `.env` themselves; no secret ever appeared in output.

`scripts/hermes-setup.sh check`: all variables `set`, `.env permissions: 600`, `com.pharmallm.mcp: loaded`, `pharmallm-mcp: healthy`.

### Services

`com.pharmallm.mcp` loads in `gui/$UID`; the Hermes gateway loads in `user/$UID` (`hermes gateway install` chooses the domain). `check` probes only `gui`, so it reports the gateway "not loaded" although `hermes gateway status` shows it supervised by launchd.

### Tools

- `hermes mcp test pharmallm`: connected in 287 ms, 16 tools discovered.
- `hermes tools list --platform telegram`: `pharmallm [excluded: start_reindex]`; browser, cronjob and computer_use disabled; terminal enabled.
- `hermes tools list --platform cron`: terminal and file disabled; `pharmallm [excluded: start_reindex]`.

### Answers and timing

| Run | Tools used | Wall clock |
|---|---|---|
| CLI one-shot (Dell PowerProtect) | 2× search_knowledge, 2× ask_pharmallm | 549 s |
| CLI one-shot (ransomware groups) | 4× search_knowledge | 652 s |
| Telegram round trip | search_knowledge, graph_search, ask_pharmallm | ≈15–20 min |

Token accounting for the first run: input 12,256, output 535, cache_read 32,402, total 45,193. Each tool step costs roughly a full prefill (≈160 s at ≈107 tok/s), while two identical `/v1` requests cache correctly (156 s then 5.8 s) — Hermes' prompt prefix changes per request, so Ollama's cache rarely hits. Answers were correct and sourced.

### Scheduled jobs

All four ran once. Health watch answered `[SILENT]` and delivered nothing; the feedback digest delivered a real weekly report; the news digest ran the agent (21 new articles across 188 topics) and delivered a summary; gap resolution answered `[SILENT]` because of the status-filter defect below.

Defects found live (fixed in the final fix wave):
1. **Cron provider:** jobs store `provider_snapshot: "custom"` (the `:pharmallm` suffix is dropped), so `hermes cron run` failed with "provider 'custom' resolved without credentials". A `cron: {model, model_provider}` block in the config fixes every job; verified live.
2. **Gap status filter:** gap rows carry `triggered` (or `skipped`, then `resolved`/`unresolved`), but `list_knowledge_gaps` only accepted `detected|resolved|unresolved`, so every filter returned an empty list. `/api/knowledge/gaps` returns 50 rows, all `triggered`.
3. **Docker sandbox:** the sandbox image is not present, and the first use pulls it inside the tool-call timeout; the colima VM also has 1.91 GB RAM / 2 CPUs against the configured 2 GB / 2 CPUs. Sandbox shell is therefore unavailable, and Hermes' file-spill of long tool output cannot be read back.

### Security checks

- `web_extract` on `http://localhost:8100/api/v2/heartbeat` and `http://localhost:7474`: both `Blocked: URL targets a private or internal network address`, so ChromaDB and Neo4j are unreachable from Hermes' web tools.
- Telegram accepted only the allowed user ID; the gateway logs secret redaction as enabled.
- Sandbox isolation (no host files, no network) could not be verified live because the container never started; its `docker run` line does contain `--network=none` and no host mounts beyond Hermes' own read-only credential, skill and cache dirs.

### Environment note

`docker pull` hangs with no output for any image (including `alpine:3.20`) while the VM reaches `auth.docker.io` (200) and the registry (401) normally — the daemon appears wedged after an interrupted pull. A `colima restart` (which also restarts Neo4j and SearXNG) is the likely remedy, left to the user.

## After the final-review fixes (2026-09-17)

`scripts/hermes-setup.sh install-config` and `install-cron` re-applied the config and updated all four jobs. Live checks:

- `hermes mcp test pharmallm_cron`: connected in 329 ms.
- `hermes tools list --platform cron`: only `session_search` enabled — web, search, memory, skills, todo, terminal, file and cronjob all disabled.
- A throwaway cron job asked to list its own `mcp__` tools (delivered locally, then removed) answered with exactly 14 names, all `mcp__pharmallm_cron__*`:

```
ask_pharmallm, dashboard_metrics, feedback_report, graph_search, graph_stats, knowledge_status,
list_knowledge_gaps, news_agent_status, record_feedback, reindex_status, resolve_knowledge_gap,
run_news_agent, search_knowledge, system_health
```

No `add_knowledge`, no `start_reindex`, and no `mcp__pharmallm__*` tool at all: scheduled runs never connect to the write-capable server. Telegram and CLI keep the full `pharmallm` server (15 tools, `start_reindex` excluded).

Still open: sandbox isolation (spec Testing item 6) remains unproven because the Docker daemon is wedged — `docker pull` hangs for any image while the VM reaches the registry normally. After `colima restart` and `docker pull nikolaik/python-nodejs:python3.11-nodejs20`, one shell-tool call can close it.

## Sandbox isolation (closed 2026-09-18)

The sandbox image was missing because `~/.docker/config.json` sets `credsStore: desktop` while Docker Desktop is not running: `docker pull` hangs in `docker-credential-desktop` before it ever reaches the daemon (the colima daemon log recorded no pull attempts at all). Pulling with a credential-helper-free config against the colima socket succeeded in under a minute:

```bash
DOCKER_CONFIG=<empty dir> DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" \
  docker pull nikolaik/python-nodejs:python3.11-nodejs20      # 2.21 GB
```

With the image present, a Hermes shell call ran and the sandbox behaved as designed:

```
sandbox-ok
ls: cannot access '/Users': No such file or directory
/root/.hermes: . .. attachments cache images
host.docker.internal: no DNS answer
wget http://host.docker.internal:3000/api/health -> WGET_FAILED
```

`docker inspect` of the live container:

```
network=none  memory=536870912 (512 MB)  cpus=1000000000 (1)
/Users/seb/.hermes/sandboxes/docker/default/home      -> /root       (rw)
/Users/seb/.hermes/sandboxes/docker/default/workspace -> /workspace  (rw)
… 11 read-only mounts, all under ~/.hermes (skills, images, attachments, cache/*)
```

No host project directory, no home directory, no `.env`, and no network. Spec Testing item 6 is met. The configured 512 MB / 1 CPU limits are applied.

Operational note: pre-pulling the sandbox image needs the credential-helper workaround above (or a running Docker Desktop) until `credsStore` is removed from `~/.docker/config.json`.

## Correction: where the time actually went (2026-09-18)

The Task 8 section above concluded that "each tool step costs roughly a full prefill … Hermes' prompt prefix changes per request, so Ollama's cache rarely hits". **That was wrong.** Measured afterwards:

- Appending to a conversation keeps the cache: a 14.6K-token prompt cost 140.6 s cold, 0.3 s when resent identically, and 10.9 s / 11.1 s when a ~1K-token tool result was appended (`cached` 14,610 of 15,651).
- An embedding call between two chat calls does not evict it either (0.4 s afterwards).
- Ollama's own log for the live Telegram window (21:10–21:50) shows the cache working: one request evaluated 9,083 prompt tokens (79.8 s); the other 29 evaluated 159–2,339 tokens (0.6–24 s each).
- That window totalled 743 s of model time across 30 requests: **364 s prefill** (37,912 tokens at ~104 tok/s) and **379 s generation** (4,504 tokens at 11.9 tok/s) — roughly half and half.

So the cost was not cache misses. It was the sheer size of what each tool returned, re-read as it entered the context, plus generation at 11.9 tok/s.

### Root cause: tool payloads

| Tool result | Before | After |
|---|---|---|
| `search_knowledge` (5 chunks) | 194,518 chars ≈ 48,600 tokens | 4,431 chars ≈ 1,100 tokens |
| `knowledge_status` | ~40,000 chars ≈ 10,000 tokens | 2,106 chars ≈ 527 tokens |
| `news_agent_status` | 8,855 chars ≈ 2,200 tokens | 1,047 chars ≈ 262 tokens |
| `list_knowledge_gaps` | 123,927 chars ≈ 31,000 tokens | 10,804 chars ≈ 2,700 tokens |

Each search chunk carried a ~30 KB `embedding` object next to ~440 characters of text — 98% of the payload was a vector no agent can use. `knowledge_status` shipped all 1,080 source names, `news_agent_status` all 188 scrape topics, and the gap list shipped every stored model answer for 50 rows.

This also explains Hermes spilling tool output to a file (its 50,000-character cap) and then needing the shell tool to read it back, which is what the wedged Docker sandbox blocked.

Fixed in `mcp/src/tools/compact.ts`: embeddings dropped, long lists replaced by `{count, sample, truncated}`, stored answers truncated to 300 characters, and `list_knowledge_gaps` capped at 20 rows by default (`limit` up to 50). PharmaLLM's REST API and the web UI are unchanged; this only shapes what the agent receives.

### Telegram round trip after the payload fix (2026-09-18)

Measured from `~/.hermes/logs/gateway.log`, gateway already warm:

```
05:31:26  inbound message: platform=telegram … msg='Any known cyber events ag…'
05:33:13  response ready: … time=107.7s
05:33:13  [Telegram] Sending response (1145 chars)
```

Round trip 1 min 47 s, against 15–20 min for a comparable question before the fix. A CLI one-shot with six tool calls ran in 179 s (652 s before). Two caveats the same session showed:

- Restarting `pharmallm-mcp` while the gateway runs costs the next message about 3 minutes: Hermes rebuilds its tool list, so the cached prompt is gone (measured: 05:23:37 inbound → 05:29:03 answer, with the first model call only at 05:26:35).
- Questions that reach `ask_pharmallm` pay for a full RAG answer on the 27B (47 s in that run) on top of Hermes' own turns.

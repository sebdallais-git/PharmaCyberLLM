# oMLX Third Stack and UI Stack Switching

## Overview

Two deliverables:

1. **oMLX as a third LLM stack** beside Ollama and MLX, installed in a project venv and driven by `scripts/switch-stack.sh ollama|mlx|omlx`. It serves chat and embeddings from one process and shares the MLX index, because its embeddings are identical.
2. **Stack switching from the web UI**, confirmed out of band through Telegram: the browser requests a switch, the owner taps a one-time link in a Telegram message within 5 minutes, the switch runs, and the UI follows its progress to a clear "ready" state.

Exactly one stack runs at a time, as today. The `/v1` gateway, the MCP service and Hermes follow the active stack and need no changes.

## Trial results this design rests on

Measured on 2026-09-18 on the Mac mini (M4 Pro, 48 GB), oMLX installed in a scratch venv and stopped afterwards. Same 16,752-token prompt used on all stacks:

| | Ollama | MLX | oMLX |
|---|---|---|---|
| Cold prompt | 156.3 s | 141.2 s | 149.6 s |
| Same prompt warm | 5.8 s | 0.8 s | 7.1 s |
| Same prompt after a server restart | ≈156 s | ≈141 s | **12.6 s** |
| Agent step (appended tool result) | 10.9 s / 11.1 s | not measured | 14.2 s / 23.4 s |

- Restart recovery is the only axis oMLX wins, and its log shows the mechanism: `Prefix cache restore … source=paged cached=16384 suffix=368 blocks=8`.
- OpenAI compatibility verified live: SSE streaming (26 content chunks over 4.9 s), `tools` function calling (`finish_reason: tool_calls`, correct `get_weather` arguments), `GET /v1/models`, `POST /v1/embeddings`.
- **Embedding parity: cosine 1.000000** against `python/mlx-embed-server.py` for the same text, both 1024 dimensions, same model.
- Its SSD cache (`~/.omlx`) grew to 4.3 GB in two short sessions.
- oMLX is alpha, roughly seven months old, about 95% of commits from one maintainer, pinning `mlx-lm` at an upstream commit for the decode loop.

## Decisions

| Topic | Decision |
|---|---|
| Placement | Third stack: `ollama`, `mlx`, `omlx`; exactly one active |
| Install | Project venv `python/omlx-venv`, pinned version, created by `switch-stack.sh prepare`; no Homebrew, no .dmg |
| Ports | One server on 127.0.0.1:8090 serving chat and embeddings |
| Index | Shares `knowledge_base_mlx` and `.index.mlx.json` with the MLX stack; no third index, no rebuild |
| Index safety | Embedding parity probe against a committed reference vector at stack start; refuse to serve below cosine 0.9999 |
| UI switch auth | No token on the route; approval comes from a one-time link in a Telegram message |
| Confirmation window | 5 minutes, then the pending switch expires and the UI reverts |
| Readiness | Progress written to `data/run/stack-switch.json`; the UI polls it and `/api/health` |
| Telegram credentials | `data/run/telegram-bot-token` and `data/run/telegram-chat-id`, mode 600, passed to the app by `start_app` |
| Out of scope | Two stacks at once, exposing oMLX on the network, the menu-bar app, Hermes changes |

## Architecture

```
Browser ──POST /api/stack/switch──▶ PharmaLLM ──sends one message──▶ Telegram
   ▲                                    │                               │
   │ polls /api/stack/status            │ writes data/run/stack-switch.json
   │ and /api/health                    ▼                               │
   └──────────────────────────── scripts/switch-stack.sh <target> ◀──tap link
                                        │        (detached: outlives the app)
                     stop others ──▶ start target ──▶ warm up ──▶ ensure index ──▶ start app
```

Stacks:

```
ollama  :11434  chat + embeddings   knowledge_base_ollama / .index.ollama.json
mlx     :8080 chat, :8081 embed     knowledge_base_mlx    / .index.mlx.json
omlx    :8090 chat + embeddings     knowledge_base_mlx    / .index.mlx.json   (shared)
```

## Component 1: the omlx stack

### Stack configuration (`src/config/llm-stacks.ts`)

- `StackName` becomes `"ollama" | "mlx" | "omlx"`; `getActiveStack` accepts the new value and its error message lists all three.
- New entry:
  - `chatBaseUrl` and `embedBaseUrl`: `env.OMLX_URL ?? "http://localhost:8090"`
  - `chatModel`: `mlx-community--Qwen3.8-27B-4bit` (oMLX's discovery id, double dashes)
  - `embeddingModel`: `mlx-community--Qwen3-Embedding-0.6B-8bit`
  - `embeddingDim`: 1024
  - `chromaCollection`: `knowledge_base_mlx`, `indexFile`: `.index.mlx.json` (both shared with mlx)
  - `chatExtraBody`: `{ chat_template_kwargs: { enable_thinking: false } }`, the same switch MLX uses; the first task verifies oMLX honours it and records the evidence.

### Install and processes (`scripts/switch-stack.sh`)

- `OMLX_VENV="$PROJECT_DIR/python/omlx-venv"`, `OMLX_PORT="8090"`, `OMLX_VERSION` pinned to the trialled commit, `OMLX_CACHE_LIMIT_GB` default 20.
- `prepare` creates the venv if missing and installs the pinned oMLX; models come from the existing Hugging Face cache, so nothing is downloaded twice.
- `start_omlx` launches `omlx serve --host 127.0.0.1 --port "$OMLX_PORT" --model-dir "$HF_CACHE"` with `nohup`, writes `data/run/omlx.pid`, logs to `data/logs/omlx.log`, and waits for `GET /v1/models`.
- `stop_omlx` stops it by PID file and port, like MLX.
- `other_stack()` is replaced by `stop_other_stacks <target>`, which stops every stack except the target. This is the one structural change: the current helper assumes exactly two.
- `models_ready omlx` checks the venv binary and both model snapshots.
- `warm_up omlx` calls chat and embeddings on :8090.
- `status` reports :8090 and the size of `~/.omlx`.
- `ensure_index` is unchanged: for `omlx` it resolves to the MLX index because the stack config says so.

### Embedding parity guard

- A committed fixture holds a probe sentence and the reference vector produced by the MLX embedding server (1024 floats, recorded once and regenerated only deliberately).
- `switch-stack.sh` runs the probe after `start_omlx` and before `start_app`: embed the sentence on :8090, compare with the fixture, require cosine ≥ 0.9999.
- Below that the switch fails with a message naming the fixture and the measured value, and the existing rollback restores the previous stack. Rationale: a silently drifting embedding would poison retrieval against a shared index, which is worse than a refused switch.

## Component 2: UI stack switching

### State machine (`src/services/stack-switch.ts`)

Pure module, injected clock and token generator, no HTTP and no process spawning.

- `requestSwitch(target, now)` → `{ id, target, token, expiresAt }`, or a typed refusal when: the target is already active, another request is pending, a benchmark is running (`isBenchmarkActive`), or a reindex job is running.
- `confirmSwitch(token, now)` → the pending request, then marks it consumed. A second confirm, an unknown token or an expired one is refused.
- `pendingSwitch(now)` → the live request or null, expiring it when past `expiresAt`.
- Progress is read from `data/run/stack-switch.json`, written by the script: `{ phase, target, previous, startedAt, finishedAt?, error? }` with phases `confirmed | stopping | starting | warming | indexing | ready | failed`.

### Routes (`src/api/stack.ts`, browser routes, no token)

- `POST /api/stack/switch` `{ stack }` → 202 `{ status: "pending_confirmation", expires_at }`, or 409 with the reason. Sends exactly one Telegram message.
- `GET /api/stack/confirm?token=…` → a small HTML page saying the switch has started, then spawns the script detached. An invalid, used or expired token returns a plain refusal page.
- `GET /api/stack/status` → `{ active, pending: { target, expires_at } | null, progress }`. Never returns the token or the chat id.

### Telegram sending (`src/services/telegram-notify.ts`)

- One function, `sendMessage(text)`, posting to the Bot API with the token and chat id from the environment; a 10-second timeout; failures are logged as "telegram notify failed" without the token and surface to the caller so the route can refuse the switch rather than pretend approval was requested.
- The app only ever sends. It never polls for updates, because Hermes' gateway is the single allowed consumer of that bot's updates.
- Two messages per switch: the confirmation request with the link, and a completion notice naming the stack, the model and the elapsed time (or the failure).

### UI (`public/index.html`, `public/app.js`)

- A stack selector beside the model selector, populated from `/api/stack/status`, with the active stack selected.
- Choosing another stack posts the request, locks the selector on the pending value, and shows "confirm in Telegram" with a countdown.
- On expiry or refusal the selector reverts to the active stack and the reason is shown.
- While switching, the UI polls `/api/stack/status` and `/api/health` every 3 seconds, tolerating connection refused, and shows the phase.
- On `ready` it shows the stack, the model and the duration, and reloads the model list.
- When Telegram credentials are absent the selector renders disabled with "Telegram confirmation not configured", so a switch can never happen without approval.

## Error handling

| Situation | Behaviour |
|---|---|
| Telegram send fails | Switch refused, nothing pending, UI shows the failure |
| No confirmation in 5 minutes | Request expires, selector reverts, no process started |
| Link tapped twice | Second tap refused; one switch per token |
| Target stack fails to start | Script rolls back to the previous stack; state file `failed`; completion message says so |
| Parity probe fails | Switch aborted before the app restarts; previous stack restored |
| Benchmark or reindex running | Switch refused with the reason |
| App killed mid-switch | The detached script owns the sequence; the state file carries the phase |
| Hermes mid-switch | Tools fail for a minute or two and Hermes reports it; scheduled jobs report the failure |

## Testing

Automated:
- **State machine:** request, refusals (already active, pending, benchmark, reindex), confirm once, reject reuse, expiry at the boundary, progress parsing of a malformed file.
- **Routes:** 202 with a pending body, exactly one Telegram send (fake sender), 409 refusals, confirm page on a good token, refusal page on a bad one, and an assertion that no response body or log line contains the token or the chat id.
- **Script:** stub `omlx`; `stop_other_stacks` stops both non-targets; the start line carries host, port and model dir; the parity probe runs before `start_app`; `prepare` creates the venv only when missing; usage header matches the `sed` range.
- **Config:** the omlx entry shares the MLX collection and index file, dimensions match, and `getActiveStack` accepts all three names.
- **Parity:** cosine against the committed fixture, including a drift case that must fail.
- Existing suites stay green: root 173, mcp 64.

Live verification (recorded in a verification doc):
1. `prepare` installs the venv; `switch-stack.sh omlx` brings up :8090 and the app reports `omlx healthy`.
2. Chat, search and a tool call through `/v1` on omlx.
3. A UI switch end to end: message received, link tapped, phases observed, ready state and completion message.
4. The revert path: request a switch, ignore it, confirm the selector reverts after 5 minutes and no process started.
5. A refused switch while a reindex runs.
6. Benchmark all three stacks and update the README table.
7. Memory and disk after a day: `~/.omlx` below the cache ceiling.

## New and modified files

| File | Change |
|---|---|
| `src/config/llm-stacks.ts` | Third stack entry, `StackName` union |
| `src/services/stack-switch.ts`, `src/services/telegram-notify.ts` | New |
| `src/api/stack.ts` | New routes, mounted after the auth middleware as browser routes |
| `src/api/auth.ts` | `/api/stack/*` added to `BROWSER_ROUTES` |
| `scripts/switch-stack.sh` | omlx start/stop/prepare, `stop_other_stacks`, parity probe, `telegram` subcommand, status additions, progress writes |
| `public/index.html`, `public/app.js` | Stack selector, pending and progress states |
| `__tests__/…`, fixture for the reference vector | New tests |
| `README.md`, `docs/…` | Three-stack documentation and the benchmark table |

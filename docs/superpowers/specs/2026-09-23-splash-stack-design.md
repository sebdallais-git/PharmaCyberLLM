# Splash as a fourth interchangeable stack

**Date:** 2026-09-23
**Status:** approved design, not yet implemented
**Goal:** run `incoai/Qwen3.8-27B-Splash` under Splash as a fourth stack beside
ollama, mlx and omlx, switchable the same way and benchmarkable against them.

## Why

Three stacks exist so the same knowledge base can be served by different
engines and compared on the same prompts. Splash is a fourth engine for the
same 27B-class model, and the comparison is the point: it ships a 1.2 GB draft
model for speculative decoding, which none of the current stacks use, and the
current MLX stack has been the source of this project's worst operational
failures — a wedged server that answered `/v1/models` while generating nothing,
and `[metal::malloc] Resource limit exceeded` under a single model.

Whether Splash is better is a measurement, not an assumption. This design's job
is to make that measurement possible without special-casing anything.

## Confirmed from the Splash documentation

Verified against the repository README, `DEVELOPMENT.md` and the model card on
2026-09-23 — not assumed:

| Question | Answer |
|---|---|
| OpenAI-compatible chat | Yes — `/v1/chat/completions`, streaming, tool calls, JSON Schema, images, inline PDFs |
| Other endpoints | `/v1/responses`, `/v1/messages`, `/tokenize`, `/apply-template`, `/v1/judgments`, `/v1/systemone` |
| **Embeddings** | **No `/v1/embeddings`. Splash is chat-only.** |
| `reasoning_effort` | Per-request, and a server default via `--default-reasoning-effort` / `SPLASH_DEFAULT_REASONING_EFFORT`. Accepts `none｜minimal｜low｜medium｜high｜xhigh｜max` |
| `--max-context` | Up to 256K, default auto |
| `--max-memory` | Ceiling on Metal allocations, e.g. `28G`, default auto |
| Default bind | `127.0.0.1:8000` |
| Requirements | Apple M3 or newer, **macOS 26.4 or later**, 36 GB minimum unified memory, 48 GB recommended |
| Model | `incoai/Qwen3.8-27B-Splash`, 17.4 GB, Apache-2.0, **not gated** — 14.1 GB target + 1.2 GB draft + 0.9 GB vision encoder |
| Model format | Splash-only fixed-layout binaries. Not a Transformers or MLX checkpoint; loads nowhere else |
| First launch | Sets up Python dependencies, resolves a repository commit, verifies a manifest, then reuses the snapshot offline |

This machine is macOS 26.4 (build 25E246), M4 Pro, 48 GB — the floor exactly.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Chat | `incoai/Qwen3.8-27B-Splash` on `127.0.0.1:8000` | Splash's default bind; no `--port` to get wrong |
| Context | `--max-context 65536` | Matches the other stacks so benchmarks compare like with like |
| Reasoning | `--default-reasoning-effort none` at start | Thinking is off on every stack today; server-side beats per-request because it cannot be forgotten by a caller |
| Embeddings | Reuse the MLX embedding server on `:8081` | Splash serves none |
| Index | Share `knowledge_base_mlx` and `.index.mlx.json` | Same arrangement omlx already uses |
| Index identity | `indexStack: "mlx"`, `indexEmbeddingModel:` the MLX one | See "The index identity trap" |
| Parity guard | Runs on every splash start, refuses below cosine 0.9999 | Identical to omlx |
| Port conflict | Splash takes `:8000`; the open-jev scorer moves to `:8010` | User's choice, 2026-09-23. Nothing is bound at 8000 yet |
| Decisions service | Stays on open-jev regardless of active stack | User's choice, 2026-09-23. See "Out of scope" |
| Graph rebuild | Ollama-only, 409 on splash | Unchanged from today |

## Architecture

```
splash stack:
  chat       Splash            127.0.0.1:8000   incoai/Qwen3.8-27B-Splash
  embeddings mlx_lm.server     127.0.0.1:8081   Qwen3-Embedding-0.6B-8bit
  collection knowledge_base_mlx
  index      .index.mlx.json   stamped "mlx"
```

`src/config/llm-stacks.ts:10` claims "a fourth stack needs one edit instead of
several." **That claim is false, and this design does not rely on it.** A survey
of the codebase on 2026-09-23 found the stack list hardcoded independently in at
least eight places.

What IS true is the half that matters: the TypeScript consumers genuinely derive
from `STACK_NAMES`. `src/services/stack-switch.ts`, `src/api/stack.ts`,
`switch-labels.ts` and `reindex-stack.ts` need no changes at all, and the `/v1`
gateway, n8n and the nightly watchlist ingest resolve the active stack through
`getActiveStack()` — so they inherit splash for free. That property is real and
must be preserved.

What is NOT derived, and must be edited by hand:

| Place | What it holds |
|---|---|
| `llm-stacks.ts:112-113` | A SECOND hardcoded list in the same file — `if (name !== "ollama" && name !== "mlx" && name !== "omlx")`, not generated from `STACK_NAMES` |
| `scripts/switch-stack.sh` | Its own `STACK_NAMES=(...)` bash array plus ~9 further spots: `validate_stack`, `models_ready`, per-stack start/stop functions, both dispatch `case`s, `warm_up`, `show_logs`, `prepare`, `status`, and the CLI dispatch |
| `scripts/lib/embedding-parity.py`'s CALLER | `check_embedding_parity()` hardcodes `$OMLX_PORT`/`$OMLX_EMBED_MODEL`; `start_stack` calls it only for omlx |
| `public/app.js:788` | `STACK_LABELS` — without an entry the UI shows the raw lowercase name |
| `scripts/benchmark-stack.ts` | Two spots, both with silent wrong defaults — see Acceptance |
| `scripts/mlx-watchdog.sh:37` | `case "$stack" in mlx\|omlx)` gates whether the watchdog runs |
| `__tests__/switch-stack-config.test.ts` | Destructures `{ ollama, mlx, omlx }`; would not cover splash, and would not fail either |
| `README.md` | Several sections, all prose |

The bash array in `switch-stack.sh` is the dangerous one: it duplicates
`STACK_NAMES` with nothing but a comment and a Jest test connecting them. The
implementation should close that gap if it can do so cheaply, and must at
minimum leave the two lists provably in agreement.

### The index identity trap

`src/config/llm-stacks.ts` already carries the scar: omlx stamps `indexStack:
"mlx"` deliberately, because stamping its own name would make the index guard
reject the shared index on every `mlx ↔ omlx` switch, and the rebuild branch
**deletes the ChromaDB collection** and re-embeds the whole knowledge base.

Splash shares the same index and inherits the same rule. It must stamp `"mlx"`
and the MLX embedding model id, not its own name. A splash stack that stamps
`"splash"` would silently destroy the knowledge base on the first switch back
to mlx.

This is the single most destructive mistake available in this change.

### Why the parity guard still applies

omlx shares the MLX index because its embeddings are *identical* — cosine
1.000000, verified. Splash reuses the MLX embedding **server itself**, so the
vectors are not merely equivalent, they are the same process producing them.

The guard is therefore expected to pass trivially. It runs anyway, on every
start, because the thing it protects against is not a different model but a
wrong one: an `:8081` that is serving something else, or not running at all, or
a stack definition that drifted. Cosine 0.9999 or the start refuses.

### Lifecycle

`prepare`, `start`, `stop`, `status` and `rollback` in `scripts/switch-stack.sh`,
following omlx's implementation exactly. Specifics this stack adds:

- **`prepare` owns the first launch.** Python dependency setup, commit
  resolution, manifest verification and a 17.4 GB download. Slow, networked,
  and not something `start` should ever do implicitly.
- **`start` stops the other stacks first.** One chat model at a time on 48 GB:
  the 27B is 17.4 GB, and this machine has already produced
  `[metal::malloc] Resource limit exceeded` with a single model loaded.
- **`start` needs the MLX embedding server**, which is shared with mlx and
  omlx. It must be up before the parity guard runs, and stopping the mlx stack
  must not take it down while splash is using it.
- **No silent fallback.** A splash start that cannot reach `:8000`, or fails
  parity, fails — it does not quietly serve from another stack. This mirrors
  `getActiveStack()`'s refusal to guess.

## Testing

Everything against fakes, as elsewhere in this repo: no Splash server, no MLX,
no network, no model. The stack definition is data, so its tests are
assertions about that data — and two of them earn their place:

1. `splash.indexStack === "mlx"` and `splash.indexEmbeddingModel` equals the MLX
   stack's. A test that fails loudly is the only thing standing between a typo
   and a deleted knowledge base.
2. `STACK_NAMES` and every enumeration derived from it contain exactly four
   names, driven from the constant rather than a literal list, so a fifth stack
   cannot half-land.

## Acceptance

The user runs `scripts/benchmark-stack.ts` and the 16.7K long-prompt test
against splash and compares with the existing omlx and mlx rows.

Surveyed rather than assumed, because this is the criterion the change is
judged on:

- **`compare-benchmarks.ts` needs nothing.** It takes two arbitrary file paths
  and deserialises a generic `stack: string`. A `splash-*.json` works today.
- **The results filename needs nothing.** It is built from whatever
  `health.stack` returns, so `data/benchmarks/splash-<ts>.json` appears on its
  own.
- **`benchmark-stack.ts` needs two edits, and both fail SILENTLY without
  them.** `stackPatterns()` (~:70-79) selects `pgrep` patterns for memory
  sampling and falls through to Ollama's by `default` — an unhandled splash
  would sample the wrong processes and report plausible, wrong memory numbers.
  The `environment.stackVersion` ternary (~:205-213) has the same shape and
  would record Ollama's version against a splash run. Neither throws. Both are
  in scope here, because a benchmark that quietly measures the wrong process is
  worse than one that refuses to run.
- **The 16.7K long-prompt test is not a script.** It is a manual `curl` of a
  ~16.7K-token prompt through `/v1`, cold then warm, documented in README.md
  (~:178-192). Nothing to change; it follows the active stack. Recorded here so
  it is understood as a manual step rather than something the suite covers.

A benchmark comparison is only meaningful if the prompts and the context window
match, which is why `--max-context 65536` is a decision above rather than a
default.

## Risks accepted

**macOS 26.4 with zero headroom.** The floor is exactly this machine's version.
A Splash release that raises it to 26.5 strands the stack until the OS is
updated. Nothing in this design mitigates that; it is recorded so the failure is
recognised rather than debugged.

**A Splash-only model format.** `incoai/Qwen3.8-27B-Splash` loads nowhere else.
17.4 GB of disk is committed to one engine, and if Splash is abandoned the
artifact is dead weight. Apache-2.0 and ungated, so nothing is lost but disk.

**A fourth chat model on one GPU.** Mitigated by stopping other stacks first,
which the lifecycle already requires — but the machine's history of Metal
allocation failures means this is a real constraint, not a tidiness rule.

**`scripts/mlx-watchdog.sh` is already wrong, and splash makes it worse.** Its
gate is `case "$stack" in mlx|omlx)`, but the script hardcodes port 8080 and
MLX process names throughout — so today it does not correctly watch omlx, which
runs on 8090. Whether splash needs watchdog coverage is a decision this change
must take deliberately; extending a broken gate would add a third stack it only
appears to watch. Fixing the omlx case is arguably in scope since this change
touches the same gate.

**Draft-model speculative decoding is new here.** No existing stack uses it.
It may change latency characteristics in ways the current benchmark harness
does not capture — tokens/sec may not mean quite the same thing. Worth watching
when the numbers land rather than designing around now.

## Out of scope

- **Splash answering `/v1/systemone`.** Splash implements the same System One
  contract as the open-jev scorer, with a 27B rather than a 4B. That is
  potentially better and cheaper than either current option, and deliberately
  not wired here: the shadow-detection experiment is trying to measure ONE
  scorer, and a scorer whose model silently changed with the active stack would
  turn that data into a mixture of two. Revisit once the shadow numbers exist.
- **`/v1/judgments`, `/v1/responses`, `/v1/messages`, vision, inline PDFs.**
  Splash offers more surface than this app uses. A fourth stack is a swap, not
  a feature expansion.
- **Graph rebuild on splash.** Stays Ollama-only and returns 409, unchanged.

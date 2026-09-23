# Splash Fourth Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `splash` as a fourth interchangeable stack, serving `incoai/Qwen3.8-27B-Splash` on `127.0.0.1:8000` with embeddings reused from the MLX server on `:8081`.

**Architecture:** Splash is chat-only, so it borrows the MLX embedding server and shares `knowledge_base_mlx` / `.index.mlx.json` exactly as `omlx` does — including stamping the MLX index identity. The stack definition is data; the lifecycle is five new shell functions modelled on `omlx`, plus two shared helpers extracted so `mlx` and `splash` can both start the embedding server and both run the parity guard.

**Tech Stack:** TypeScript (strict, ESM), bash, Jest, Splash (Apple-silicon inference engine).

**Spec:** `docs/superpowers/specs/2026-09-23-splash-stack-design.md`

## Global Constraints

- TypeScript strict; ES modules; relative imports end in `.js`; no `any` — `unknown` with type guards; interfaces over type aliases except string-literal unions; kebab-case filenames; camelCase functions; comments in English.
- **No test may touch a live service** — no Splash, no MLX, no Ollama, no network, no model, no real ChromaDB. Tests drive fixtures and fakes.
- Both `npm run typecheck` and `npm run typecheck:tests` must be clean. `npm test` transpiles without typechecking, so a type error in a test file will NOT fail the suite.
- Run the full suite and check its real exit code: `npm test > /tmp/out.txt 2>&1; echo $?`. Never judge success by piping into grep or tail.
- After each test run, check `git status`. A test that creates a file on disk is a defect even when the suite is green.
- **`splash` MUST stamp `indexStack: "mlx"` and `indexEmbeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit"`.** Stamping `"splash"` makes the index guard reject the shared index on the next switch, and the rebuild branch DELETES the ChromaDB collection and re-embeds the whole knowledge base.
- Splash chat: `incoai/Qwen3.8-27B-Splash`, `127.0.0.1:8000`, `--max-context 65536`, `--default-reasoning-effort none`.
- Do NOT start, stop or install Splash, Ollama, MLX or oMLX. Do not run `scripts/switch-stack.sh` against a real stack. Do not download the 17.4 GB model.
- No silent fallback anywhere: a splash start that cannot reach `:8000` or fails parity must fail.

---

### Task 1: The stack definition

**Files:**
- Modify: `src/config/llm-stacks.ts` (lines 5, 10, the `buildStacks` return, and the guard at ~112)
- Test: `__tests__/llm-stacks.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `StackName` gains `"splash"`; `STACK_NAMES` becomes 4 long; `buildStacks(env).splash` is a `StackConfig`

- [ ] **Step 1: Write the failing test**

Create `__tests__/llm-stacks.test.ts` (check first whether one already exists; if so, append these cases to it):

```typescript
import { describe, expect, it } from "@jest/globals";
import { buildStacks, isStackName, STACK_NAMES } from "../src/config/llm-stacks.js";

describe("the splash stack", () => {
  it("is a known stack name", () => {
    expect(STACK_NAMES).toEqual(["ollama", "mlx", "omlx", "splash"]);
    expect(isStackName("splash")).toBe(true);
  });

  it("serves chat from Splash and embeddings from the MLX server", () => {
    const { splash } = buildStacks({});

    expect(splash.chatBaseUrl).toBe("http://localhost:8000");
    expect(splash.embedBaseUrl).toBe("http://localhost:8081");
    expect(splash.chatModel).toBe("incoai/Qwen3.8-27B-Splash");
    expect(splash.embeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  // THE DESTRUCTIVE MISTAKE THIS TEST EXISTS TO PREVENT:
  // splash shares .index.mlx.json and knowledge_base_mlx with mlx and omlx.
  // The index guard compares the stamped identity against the running stack's;
  // a mismatch takes the rebuild branch, and reindex DELETES the ChromaDB
  // collection before re-embedding. Stamping "splash" here would destroy the
  // knowledge base on the first switch back to mlx.
  it("stamps the MLX index identity, not its own", () => {
    const { splash, mlx } = buildStacks({});

    expect(splash.indexStack).toBe("mlx");
    expect(splash.indexEmbeddingModel).toBe(mlx.indexEmbeddingModel);
    expect(splash.chromaCollection).toBe(mlx.chromaCollection);
    expect(splash.indexFile).toBe(mlx.indexFile);
  });

  // The spec requires the /v1 gateway, n8n and the nightly ingest to follow the
  // active stack with no code change. They all resolve it through
  // getActiveStack(), so this is inherited -- pinned rather than assumed.
  it("is a complete StackConfig, so every getActiveStack consumer works unchanged", () => {
    const { splash, mlx } = buildStacks({});

    expect(Object.keys(splash).sort()).toEqual(Object.keys(mlx).sort());
    expect(Object.values(splash).every((v) => v !== undefined && v !== "")).toBe(true);
  });

  it("honours SPLASH_URL and MLX_EMBED_URL overrides", () => {
    const { splash } = buildStacks({ SPLASH_URL: "http://127.0.0.1:9000", MLX_EMBED_URL: "http://127.0.0.1:9001" });

    expect(splash.chatBaseUrl).toBe("http://127.0.0.1:9000");
    expect(splash.embedBaseUrl).toBe("http://127.0.0.1:9001");
  });

  // getActiveStack narrows the name with a hand-written list that is NOT
  // generated from STACK_NAMES. It is a second source of truth in the same
  // file and silently rejects any stack missing from it.
  it("resolves splash through getActiveStack", async () => {
    const { getActiveStack } = await import("../src/config/llm-stacks.js");

    expect(getActiveStack({ LLM_PROVIDER: "splash" }, () => null).name).toBe("splash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- llm-stacks`
Expected: FAIL — `STACK_NAMES` has three entries and `buildStacks({}).splash` is undefined.

- [ ] **Step 3: Add the stack name**

In `src/config/llm-stacks.ts`, line 5 and line 10:

```typescript
export type StackName = "ollama" | "mlx" | "omlx" | "splash";

export const STACK_NAMES: readonly StackName[] = ["ollama", "mlx", "omlx", "splash"];
```

- [ ] **Step 4: Add the stack definition**

In the `buildStacks` return object, after the `omlx` entry:

```typescript
    // Splash is chat-only -- it exposes no /v1/embeddings at all -- so it
    // borrows the MLX embedding server and shares the MLX index, the same
    // arrangement omlx uses. See the indexStack comment on omlx above: the
    // identity stamped here is deliberately "mlx", because a mismatch sends
    // the next switch down the rebuild branch, which DELETES the collection.
    splash: {
      name: "splash",
      chatBaseUrl: env.SPLASH_URL ?? "http://localhost:8000",
      embedBaseUrl: env.MLX_EMBED_URL ?? "http://localhost:8081",
      chatModel: "incoai/Qwen3.8-27B-Splash",
      embeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      indexStack: "mlx",
      indexEmbeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    },
```

- [ ] **Step 5: Fix the second hardcoded list in the same file**

Around line 112 `getActiveStack` narrows with a hand-written list. Replace it with the closed-set guard that already exists, so this file stops carrying two sources of truth:

```typescript
  if (!isStackName(name)) {
    throw new Error(`Unknown stack "${name}" (expected one of: ${STACK_NAMES.join(", ")})`);
  }
```

Read the surrounding lines before editing — keep whatever the existing branch does after the check, and keep the existing `null`/`undefined` refusal above it intact.

- [ ] **Step 6: Run tests**

Run: `npm test -- llm-stacks` — Expected: PASS
Run: `npm test` — Expected: all suites pass. If `__tests__/switch-stack-config.test.ts` fails, that is EXPECTED — it asserts the shell list matches; Task 2 fixes the shell side. Note the failure and continue; do not edit the shell script in this task.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:tests
git add src/config/llm-stacks.ts __tests__/llm-stacks.test.ts
git commit -m "feat: define the splash stack, sharing the MLX index"
```

---

### Task 2: Shell lifecycle

**Files:**
- Modify: `scripts/switch-stack.sh`
- Test: `__tests__/switch-stack-config.test.ts`

**Interfaces:**
- Consumes: `buildStacks().splash` from Task 1
- Produces: `switch-stack.sh splash` works; `start_splash`, `stop_splash`, `start_mlx_embed`, `check_embedding_parity <base-url> <model>`

This is the largest task. The script hand-enumerates stacks in ten places.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/switch-stack-config.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStacks, STACK_NAMES } from "../src/config/llm-stacks.js";

const script = readFileSync(join(process.cwd(), "scripts", "switch-stack.sh"), "utf8");

describe("switch-stack.sh knows every stack", () => {
  // The shell keeps its own STACK_NAMES array; nothing but this test connects
  // the two lists. A stack present in TypeScript and absent here is switchable
  // from the UI and unstartable from the shell.
  it("declares the same stack list as llm-stacks.ts", () => {
    const match = script.match(/^STACK_NAMES=\(([^)]*)\)/m);

    expect(match).not.toBeNull();
    expect(match?.[1].trim().split(/\s+/)).toEqual([...STACK_NAMES]);
  });

  it.each([...STACK_NAMES])("dispatches, validates and can start/stop %s", (stack: string) => {
    // validate_stack's case arm
    expect(script).toMatch(new RegExp(`\\b${stack}\\b[^)]*\\)\\s*;;`));
    // a models_ready arm
    expect(script).toMatch(new RegExp(`^\\s*${stack}\\)`, "m"));
  });

  it("starts splash on the port the stack definition expects", () => {
    const { splash } = buildStacks({});
    const port = new URL(splash.chatBaseUrl).port;

    expect(script).toMatch(new RegExp(`SPLASH_PORT="?\\$\\{SPLASH_PORT:-${port}\\}"?`));
  });

  it("passes the context and reasoning flags the spec fixes", () => {
    expect(script).toContain("--max-context 65536");
    expect(script).toContain("--default-reasoning-effort none");
  });

  // splash has no embeddings of its own, so its start must bring up the MLX
  // embedding server AND run parity against it -- not against :8000.
  it("runs the parity guard for splash against the embedding server", () => {
    expect(script).toMatch(/splash\)\s*start_splash && check_embedding_parity/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- switch-stack-config`
Expected: FAIL — the shell `STACK_NAMES` array is `(ollama mlx omlx)`.

- [ ] **Step 3: Add the configuration block**

Beside the other stack constants near the top of `scripts/switch-stack.sh` (the `OMLX_*` block ends around line 63):

```bash
# --- Splash ---------------------------------------------------------------
# Chat only: Splash serves no /v1/embeddings, so this stack borrows the MLX
# embedding server on $MLX_EMBED_PORT and shares the MLX index.
SPLASH_PORT="${SPLASH_PORT:-8000}"
SPLASH_CHAT_MODEL="${SPLASH_CHAT_MODEL:-incoai/Qwen3.8-27B-Splash}"
SPLASH_DIR="${SPLASH_DIR:-$PROJECT_DIR/python/splash-src}"
SPLASH_BIN="${SPLASH_BIN:-$SPLASH_DIR/splash}"
SPLASH_REPO="https://github.com/incoai/splash"
# Matches the other stacks so benchmark rows compare like with like
SPLASH_MAX_CONTEXT="${SPLASH_MAX_CONTEXT:-65536}"
```

- [ ] **Step 4: Extend the four stack lists**

Line ~69:

```bash
STACK_NAMES=(ollama mlx omlx splash)
```

`validate_stack` (~line 76):

```bash
    ollama|mlx|omlx|splash) ;;
    *) log "Unknown stack '$1' (expected ollama, mlx, omlx or splash)"; return 1 ;;
```

`models_ready` (~line 95), a new arm beside the others:

```bash
    splash)
      [ -x "$SPLASH_BIN" ] && hf_snapshot_present "$SPLASH_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
```

The top-level CLI dispatch (~line 631):

```bash
  ollama|mlx|omlx|splash) switch_to "$1" ;;
```

- [ ] **Step 5: Extract the MLX embedding server into a shared helper**

`start_mlx` currently starts both servers inline. `splash` needs only the embedding half, so lift it out. Replace the embedding block inside `start_mlx` (the `if port_open "$MLX_EMBED_PORT"` … `fi` and its `wait_http`) with a call, and add the helper above `start_mlx`:

```bash
# Shared by mlx and splash: splash serves no embeddings of its own and borrows
# this server. Idempotent -- a running server owned by this project is reused
# rather than restarted, so switching mlx -> splash does not bounce it.
start_mlx_embed() {
  if port_open "$MLX_EMBED_PORT"; then
    project_listener_open "$MLX_EMBED_PORT" \
      || { log "Port $MLX_EMBED_PORT is used by another program — cannot start the embedding server"; return 1; }
  else
    nohup "$MLX_VENV/bin/python" "$PROJECT_DIR/python/mlx-embed-server.py" \
      --model "$MLX_EMBED_MODEL" --host 127.0.0.1 --port "$MLX_EMBED_PORT" \
      >"$LOG_DIR/mlx-embed.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-embed.pid"
  fi
  wait_http "http://localhost:$MLX_EMBED_PORT/v1/models" 180 \
    || { log "MLX embedding server did not become ready"; return 1; }
}
```

`start_mlx` then ends with `start_mlx_embed` after its own chat block and `wait_http`.

- [ ] **Step 6: Generalise the parity guard**

`check_embedding_parity` hardcodes `$OMLX_PORT`/`$OMLX_EMBED_MODEL`. Make it take the base URL and model:

```bash
# Stacks that share the MLX index must serve interchangeable embeddings:
# drifted vectors would silently poison retrieval, and the index guard cannot
# see the difference. Called with the URL and model of whatever is actually
# serving embeddings for the stack being started.
check_embedding_parity() {
  local base_url="$1" model="$2" out
  if out="$("$MLX_PYTHON" "$PROJECT_DIR/scripts/lib/embedding-parity.py" \
      "$base_url" "$model" \
      "$PROJECT_DIR/__tests__/fixtures/embedding-reference.json" 2>&1)"; then
    log "Embedding parity ok (${out})"
    return 0
  fi
  log "Embedding parity check failed: $out"
  return 1
}
```

- [ ] **Step 7: Add the splash processes and wire the dispatch**

Beside `start_omlx`/`stop_omlx`:

```bash
stop_splash() {
  stop_pidfile splash "$SPLASH_PORT" ignore-foreign
}

start_splash() {
  if port_open "$SPLASH_PORT"; then
    project_listener_open "$SPLASH_PORT" \
      || { log "Port $SPLASH_PORT is used by another program — cannot start Splash"; return 1; }
  else
    nohup "$SPLASH_BIN" serve --model "$SPLASH_CHAT_MODEL" \
      --host 127.0.0.1 --port "$SPLASH_PORT" \
      --max-context "$SPLASH_MAX_CONTEXT" --default-reasoning-effort none \
      >"$LOG_DIR/splash.log" 2>&1 &
    echo $! >"$RUN_DIR/splash.pid"
  fi
  wait_http "http://localhost:$SPLASH_PORT/v1/models" 300 || { log "Splash did not become ready"; return 1; }
  # Chat only: the embeddings for this stack come from the MLX server.
  start_mlx_embed
}
```

Then both dispatch `case`s. Note omlx's parity call changes shape because the helper now takes arguments:

```bash
start_stack() {
  case "$1" in
    mlx) start_mlx ;;
    omlx) start_omlx && check_embedding_parity "http://localhost:$OMLX_PORT" "$OMLX_EMBED_MODEL" ;;
    splash) start_splash && check_embedding_parity "http://localhost:$MLX_EMBED_PORT" "$MLX_EMBED_MODEL" ;;
    *) start_ollama && ensure_ollama_ctx ;;
  esac
}

stop_stack() {
  case "$1" in
    mlx) stop_mlx ;;
    omlx) stop_omlx ;;
    splash) stop_splash ;;
    *) stop_ollama ;;
  esac
}
```

- [ ] **Step 8: Add the warm-up branch**

In `warm_up`, a branch beside the `mlx`/`omlx` ones. Splash takes `reasoning_effort` directly rather than `chat_template_kwargs`, and its embeddings come from a different URL and model than its chat:

```bash
  elif [ "$1" = "splash" ]; then
    chat_url="http://localhost:$SPLASH_PORT"
    embed_url="http://localhost:$MLX_EMBED_PORT"
    chat_model="$SPLASH_CHAT_MODEL"
    embed_model="$MLX_EMBED_MODEL"
    extra='"reasoning_effort":"none"'
```

- [ ] **Step 9: Add prepare, status and logs**

In `prepare`, after the oMLX venv block:

```bash
  # Splash: a pinned checkout plus a 17.4 GB model package. The first serve
  # sets up Python dependencies and verifies the manifest, so prepare runs it
  # once here rather than letting a switch pay for it.
  if [ ! -x "$SPLASH_BIN" ]; then
    log "Installing Splash into $SPLASH_DIR"
    rm -rf "$SPLASH_DIR"
    git clone "$SPLASH_REPO" "$SPLASH_DIR"
  fi
  "$MLX_VENV/bin/python" -c "from huggingface_hub import snapshot_download as d; d('$SPLASH_CHAT_MODEL')"
```

In `status`, add splash to the port list:

```bash
  for entry in "app:$APP_PORT" "ollama:$OLLAMA_PORT" "mlx-chat:$MLX_CHAT_PORT" "mlx-embed:$MLX_EMBED_PORT" "omlx:$OMLX_PORT" "splash:$SPLASH_PORT" "chromadb:$CHROMA_PORT"; do
```

In `show_logs` (~:456), add `splash.log` to the tailed list:

```bash
  for file in "$LOG_DIR/mlx-chat.log" "$LOG_DIR/mlx-embed.log" "$LOG_DIR/omlx.log" "$LOG_DIR/splash.log" "$LOG_DIR/app.log"; do
```

- [ ] **Step 10: Run tests**

Run: `npm test -- switch-stack-config` — Expected: PASS
Run: `bash -n scripts/switch-stack.sh` — Expected: no output (syntax check; does NOT execute)
Run: `npm test` — Expected: all suites pass

Do NOT run `scripts/switch-stack.sh` itself — it would stop running services and try to start a model that is not installed.

- [ ] **Step 11: Commit**

```bash
git add scripts/switch-stack.sh __tests__/switch-stack-config.test.ts
git commit -m "feat: splash lifecycle in switch-stack.sh"
```

---

### Task 3: Benchmarks accept splash

**Files:**
- Modify: `scripts/benchmark-stack.ts` (`stackPatterns`, the `stackVersion` ternary)
- Test: `__tests__/benchmark-stack-splash.test.ts`

**Interfaces:**
- Consumes: `StackName` from Task 1
- Produces: `stackPatterns("splash")` returns splash process patterns

This is the acceptance criterion. Both current gaps fail SILENTLY — they fall through to Ollama's defaults, so a splash benchmark would report plausible, wrong numbers rather than erroring.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { stackPatterns } from "../scripts/benchmark-stack.js";
import { STACK_NAMES } from "../src/config/llm-stacks.js";

describe("benchmark process sampling", () => {
  // stackPatterns picks the pgrep patterns used to sample memory. Its default
  // arm returns Ollama's, so an unhandled stack does not error -- it silently
  // measures the wrong process and writes a plausible, wrong number into the
  // benchmark row this change exists to compare.
  it("has patterns for splash that are not Ollama's", () => {
    expect(stackPatterns("splash")).not.toEqual(stackPatterns("ollama"));
    expect(stackPatterns("splash").join(" ")).toMatch(/splash/i);
  });

  it("has distinct patterns for every stack", () => {
    const joined = STACK_NAMES.map((s) => stackPatterns(s).join("|"));

    expect(new Set(joined).size).toBe(STACK_NAMES.length);
  });
});
```

If `stackPatterns` is not currently exported, export it — that is part of this task. Do not otherwise restructure the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- benchmark-stack-splash`
Expected: FAIL — `stackPatterns("splash")` equals the Ollama patterns.

- [ ] **Step 3: Add the splash arm**

`stackPatterns` is already exported (`scripts/benchmark-stack.ts:70`). Add a case before the `default`:

```typescript
    case "splash":
      // Splash serves from a single process. Both spellings are accepted for
      // the same reason the omlx arm accepts two: the process title is not
      // guaranteed stable across versions, and an unmatched pattern samples
      // nothing rather than erroring.
      return ["splash-server", "splash serve"];
```

**Verify the pattern against a running Splash before trusting the memory
numbers.** Nothing in the test suite can check that a `pgrep` pattern matches a
real process. If it matches nothing, the benchmark reports zero memory rather
than failing — record in your report that this pattern is unverified and must
be confirmed by hand on the first live run.

For `environment.stackVersion` (~:205-213), the existing branches call the
file's own `run()` helper. Add splash beside them:

```typescript
        : stack === "omlx"
          ? run(join(process.cwd(), "python", "omlx-venv", "bin", "omlx"), ["--version"])
          : stack === "splash"
            ? run(join(process.cwd(), "python", "splash-src", "splash"), ["--version"])
            : run("ollama", ["--version"]),
```

- [ ] **Step 4: Run tests**

Run: `npm test -- benchmark-stack-splash` — Expected: PASS
Run: `npm test` — Expected: all suites pass
Run: `npm run typecheck && npm run typecheck:tests` — Expected: clean

Do NOT run `benchmark-stack.ts` — it calls a live app and a live model.

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-stack.ts __tests__/benchmark-stack-splash.test.ts
git commit -m "feat: sample the right process when benchmarking splash"
```

---

### Task 4: UI label and the scorer port move

**Files:**
- Modify: `public/app.js` (`STACK_LABELS` ~:788, and the fallback array ~:838)
- Modify: `config/decide.yaml` (the scorer's base_url)
- Test: `__tests__/switch-labels.test.ts`

**Interfaces:**
- Consumes: `STACK_NAMES` from Task 1
- Produces: nothing later tasks depend on

Two unrelated one-liners, batched because each is too small for its own review.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/switch-labels.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STACK_NAMES } from "../src/config/llm-stacks.js";

describe("the browser stack selector", () => {
  const appJs = readFileSync(join(process.cwd(), "public", "app.js"), "utf8");

  // Without an entry the UI falls back to the raw lowercase name, so the
  // selector reads "splash" beside "Ollama", "MLX" and "oMLX".
  it("has a display label for every stack", () => {
    const block = appJs.match(/const STACK_LABELS = \{([^}]*)\}/)?.[1] ?? "";

    for (const stack of STACK_NAMES) {
      expect(block).toMatch(new RegExp(`\\b${stack}\\s*:`));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- switch-labels`
Expected: FAIL — `STACK_LABELS` has no `splash` key.

- [ ] **Step 3: Add the label and fix the fallback**

`public/app.js` ~:788:

```javascript
const STACK_LABELS = { ollama: "Ollama", mlx: "MLX", omlx: "oMLX", splash: "Splash" };
```

`public/app.js:838` — the fallback used only when the API omits `stacks`:

```javascript
  const options = (status.stacks || ["ollama", "mlx", "omlx", "splash"])
```

- [ ] **Step 4: Move the scorer off port 8000**

Splash binds `127.0.0.1:8000` by default and `config/decide.yaml` assigns that to the open-jev scorer. Nothing is bound there yet, so the scorer moves. In `config/decide.yaml`:

```yaml
# 8010, not 8000: Splash (the fourth LLM stack) binds 127.0.0.1:8000 by default
# and running both is the common case. Splash keeps its default so no
# --port flag has to be remembered; the scorer has no default to preserve.
base_url: http://127.0.0.1:8010
```

Then update the two places that document the old port — `docs/superpowers/specs/2026-09-22-system-one-decision-design.md` (the Decisions table row and the architecture diagram) — so the spec does not contradict the config. Do NOT change `scripts/run-jev.sh`; it reads `JEV_PORT` with its own default, which you should also move to `8010` for consistency. Read it first and change only the default.

- [ ] **Step 5: Run tests**

Run: `npm test -- "switch-labels|decide-config"` — Expected: PASS
Run: `npm test` — Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add public/app.js config/decide.yaml scripts/run-jev.sh __tests__/switch-labels.test.ts docs/superpowers/specs/2026-09-22-system-one-decision-design.md
git commit -m "feat: label splash in the UI and move the scorer off port 8000"
```

---

### Task 4b: Pin the graph-rebuild refusal

**Files:**
- Test: `__tests__/graph-stack-gate.test.ts`

No production change. `src/api/graph.ts:65` reads
`if (getActiveStack().name !== "ollama")` and returns 409 — a negative check, so
splash is refused automatically. That is the spec's requirement met by accident
of the existing shape, which is exactly the kind of thing that breaks when
someone later rewrites the check as an allowlist.

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STACK_NAMES } from "../src/config/llm-stacks.js";

describe("graph rebuild is Ollama-only", () => {
  // Guards against a future rewrite into an allowlist, which would silently
  // start permitting whichever stacks someone remembered to list.
  it("refuses by a negative check on ollama, not an allowlist", () => {
    const src = readFileSync(join(process.cwd(), "src", "api", "graph.ts"), "utf8");

    expect(src).toMatch(/getActiveStack\(\)\.name !== "ollama"/);
    for (const stack of STACK_NAMES.filter((s) => s !== "ollama")) {
      expect(src).not.toMatch(new RegExp(`name === "${stack}"`));
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- graph-stack-gate` — Expected: PASS immediately. Say so in your
report: this test pins existing correct behaviour rather than driving a change,
and was green before you wrote any production code.

- [ ] **Step 3: Commit**

```bash
git add __tests__/graph-stack-gate.test.ts
git commit -m "test: pin that graph rebuild refuses every non-ollama stack"
```

---

### Task 5: The watchdog gate

**Files:**
- Modify: `scripts/mlx-watchdog.sh`
- Test: `__tests__/mlx-watchdog.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

The watchdog gates on `case "$stack" in mlx|omlx)` but hardcodes port 8080 and MLX process names throughout — **so it does not actually watch omlx today**, which runs on 8090. Extending the gate to splash unexamined would add a third stack it only appears to watch.

**Decision required, and it is yours to make — record it in your report:** either (a) make the watchdog port- and process-aware so it genuinely covers omlx and splash, or (b) narrow the gate to `mlx` only, which is the sole stack it can actually watch, and note the others as uncovered. Option (b) is smaller and honest; option (a) is more useful and more work. Do not leave it as it is.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(process.cwd(), "scripts", "mlx-watchdog.sh"), "utf8");

describe("mlx watchdog", () => {
  // The watchdog probes a hardcoded port. Whatever stacks its gate admits, it
  // must actually be able to watch them -- a gate that admits a stack it then
  // probes on the wrong port reports health for a server it never contacted.
  it("only admits stacks it can actually probe", () => {
    const gate = script.match(/case "\$stack" in\s*([^)]*)\)/)?.[1] ?? "";
    const admitted = gate.split("|").map((s) => s.trim()).filter(Boolean);
    const portsProbed = [...script.matchAll(/localhost:(\d+)/g)].map((m) => m[1]);

    // Either the script is parameterised by stack, or it admits exactly one.
    const parameterised = /\$\{?(MLX_CHAT_PORT|WATCH_PORT|PORT)\b/.test(script);
    expect(parameterised || admitted.length === 1).toBe(true);
    expect(new Set(portsProbed).size).toBeLessThanOrEqual(parameterised ? 99 : 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mlx-watchdog`
Expected: FAIL — the gate admits two stacks while the script probes one hardcoded port.

- [ ] **Step 3: Implement your chosen option**

Read `scripts/mlx-watchdog.sh` in full first. If you take option (b), the gate becomes `case "$stack" in mlx) ;; *) exit 0 ;; esac` and a comment records that omlx and splash are not covered and why. If you take option (a), derive the port and process pattern from the active stack.

- [ ] **Step 4: Run tests**

Run: `npm test -- mlx-watchdog` — Expected: PASS
Run: `bash -n scripts/mlx-watchdog.sh` — Expected: no output
Run: `npm test` — Expected: all suites pass

- [ ] **Step 5: Commit**

```bash
git add scripts/mlx-watchdog.sh __tests__/mlx-watchdog.test.ts
git commit -m "fix: make the watchdog gate match what it can actually watch"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` (~:64, :74, :79-91, :127-149, :161-172, :182-188, :899-918)
- Test: `__tests__/readme-stacks.test.ts`

**Interfaces:**
- Consumes: `STACK_NAMES` from Task 1
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStacks, STACK_NAMES } from "../src/config/llm-stacks.js";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("README stack documentation", () => {
  it("no longer claims there are three stacks", () => {
    expect(readme).not.toMatch(/Three interchangeable stacks/);
    expect(readme).toMatch(/Four interchangeable stacks/);
  });

  it("documents every stack and its chat port", () => {
    const stacks = buildStacks({});
    for (const name of STACK_NAMES) {
      expect(readme).toContain(name);
      expect(readme).toContain(new URL(stacks[name].chatBaseUrl).port || "11434");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- readme-stacks`
Expected: FAIL — "Three interchangeable stacks" is still present.

- [ ] **Step 3: Update the README**

Read each location before editing; these are prose tables, so match the existing column structure rather than inventing one.

- ~:64 and ~:79 — "Three interchangeable stacks" becomes "Four", and "Ollama vs MLX vs oMLX" becomes "Ollama vs MLX vs oMLX vs Splash".
- ~:83-91 the comparison table gains a splash row: chat model `incoai/Qwen3.8-27B-Splash`, port 8000, embeddings from the MLX server on 8081, collection `knowledge_base_mlx`, index `.index.mlx.json`, graph rebuild ✗ (409).
- ~:127-149 the Mermaid diagram's `-- "oMLX only" -->` parity branch now covers splash too — relabel it to name both stacks that share the MLX index.
- ~:161-188 the benchmark tables gain a splash column, left empty with a note that the row is pending the measurement.
- ~:899-918 troubleshooting gains: Splash requires macOS 26.4 or later and an M3 or newer; `Models for splash are missing` → `scripts/switch-stack.sh prepare`; a port-8000 conflict row naming the scorer.

Note in the stack table that splash serves no embeddings of its own — that is the single most surprising fact about it and the reason it borrows :8081.

- [ ] **Step 4: Run tests**

Run: `npm test -- readme-stacks` — Expected: PASS
Run: `npm test` — Expected: all suites pass

- [ ] **Step 5: Commit**

```bash
git add README.md __tests__/readme-stacks.test.ts
git commit -m "docs: document splash as the fourth stack"
```

---

## Manual steps the user must perform

No implementer can do these — they install software and start services.

1. **Install Splash and the model:** `scripts/switch-stack.sh prepare` — clones Splash, resolves its Python dependencies, and downloads 17.4 GB. Apache-2.0 and ungated, so no token is needed.
2. **Switch to it:** `scripts/switch-stack.sh splash`, confirming through the Telegram prompt as with any stack switch.
3. **Benchmark:** `npx tsx scripts/benchmark-stack.ts`, then `npx tsx scripts/compare-benchmarks.ts data/benchmarks/splash-<ts>.json data/benchmarks/mlx-<ts>.json`.
4. **The 16.7K long-prompt test** is a manual `curl` through `/v1`, cold then warm, per README ~:178-192. It follows the active stack and needs no change.

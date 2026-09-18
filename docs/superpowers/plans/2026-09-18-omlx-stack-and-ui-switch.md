# oMLX Third Stack and UI Stack Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add oMLX as a third LLM stack sharing the MLX index, and let the web UI switch stacks after a one-time Telegram confirmation.

**Architecture:** `src/config/llm-stacks.ts` gains a third entry whose ChromaDB collection and index file are the MLX ones, so no reindex is needed. `scripts/switch-stack.sh` learns to run oMLX from a project venv, to stop every non-target stack, to verify embedding parity before serving, and to write its progress to `data/run/stack-switch.json`. A pure state machine plus three browser routes turn a UI request into a Telegram confirmation link, and the script the link spawns outlives the app it restarts.

**Tech Stack:** Node 22, TypeScript strict ESM, Express 4, Jest 30 + ts-jest, bash (macOS), oMLX in a Python 3.11 venv, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-09-18-omlx-stack-and-ui-switch-design.md`

## Global Constraints

- **Stacks:** `ollama`, `mlx`, `omlx`; exactly one active. oMLX serves chat and embeddings from one process on `127.0.0.1:8090`.
- **Shared index:** the omlx stack uses `chromaCollection: "knowledge_base_mlx"` and `indexFile: ".index.mlx.json"`, identical to the mlx stack. Never create a third index.
- **Parity guard:** cosine ≥ `0.9999` against the committed reference vector, checked after starting oMLX and before starting the app; below that the switch aborts and the previous stack is restored.
- **Confirmation window:** `CONFIRM_WINDOW_MS = 5 * 60 * 1000`. One pending switch at a time. A token is single-use.
- **Switch refusals:** target already active, another request pending, benchmark active (`isBenchmarkActive()`), reindex running (`getRunningJobs().includes("reindex")`), Telegram not configured.
- **Secrets:** bot token and chat id live in `data/run/telegram-bot-token` and `data/run/telegram-chat-id` (mode 600), reach the app through its environment, and must never appear in a response body, a log line, argv or the repo.
- **Code style:** TypeScript strict, ES modules with `.js` specifiers, no `any` (use `unknown` + type guards), interfaces over type aliases, kebab-case files, English comments.
- **Test isolation:** no test touches a live service, `~/.omlx`, `~/.hermes`, launchd, Docker, Telegram, the running app, Ollama, MLX, ChromaDB or `data/run/*`. Shell tests use temp dirs, stub executables and `PATH` of `<stub dir>:/usr/bin:/bin` only — never `/opt/homebrew/bin`.
- **TDD:** never demonstrate RED by reverting implementation code; RED means running new tests before the code exists.
- **Suite baselines:** root `npm test` 173 now → T1 177 → T2 182 → T3 185 → T4 193 → T5 197 → T6 204 → T7 208 → T8 210. `npm --prefix mcp test` stays 64. `npm run typecheck`, `npm run typecheck:tests` and `npm --prefix mcp run typecheck` stay clean.
- **Ports:** app 3000 / HTTPS 3443, Ollama 11434, MLX 8080 + 8081, oMLX 8090, ChromaDB 8100, MCP 3200, SearXNG 8888.
- **Live tasks (0 and 10)** are run by the controller, not a subagent: they install software, restart the live app and need the user.
- **Commits:** `feat:`/`fix:`/`test:`/`docs:` prefixes, each ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 0: Verification spike (controller)

Confirms the oMLX behaviours the rest of the plan assumes, against the pinned version, before any code is written.

**Files:**
- Create: `docs/superpowers/plans/2026-09-18-omlx-stack-verification.md`

- [ ] **Step 1: Install the pinned version into a scratch venv**

```bash
cd "$CLAUDE_JOB_DIR/tmp/omlx-src" && git log -1 --format='%H %cs'
/Users/seb/.hermes/bin/uv venv --python 3.11 .venv
/Users/seb/.hermes/bin/uv pip install --python .venv/bin/python -e .
./.venv/bin/omlx --version
```

Record the commit SHA and the version string; that SHA is `OMLX_VERSION` in Task 2.

- [ ] **Step 2: Start it and capture the facts the plan needs**

```bash
./.venv/bin/omlx serve --host 127.0.0.1 --port 8090 --model-dir "$HOME/.cache/huggingface/hub" > /tmp/omlx-verify.log 2>&1 &
curl -s --retry 40 --retry-connrefused --retry-delay 2 http://127.0.0.1:8090/v1/models | python3 -m json.tool | head -20
./.venv/bin/omlx serve --help | grep -i -E "cache|disk|ssd|limit|gb" | head -20
grep -i -E "cache.*(size|limit|gb)|ceiling" /tmp/omlx-verify.log | head -10
```

Record: the exact model ids it reports, and whether a cache size limit exists as a CLI flag, a settings key in `~/.omlx/settings.json`, or neither.

- [ ] **Step 3: Confirm the thinking switch is honoured**

```bash
for body in '{"model":"MODEL","max_tokens":64,"messages":[{"role":"user","content":"What is 2+2? Answer with the number only."}]}' \
            '{"model":"MODEL","max_tokens":64,"chat_template_kwargs":{"enable_thinking":false},"messages":[{"role":"user","content":"What is 2+2? Answer with the number only."}]}'; do
  echo "$body" | sed "s|MODEL|mlx-community--Qwen3.8-27B-4bit|" \
    | curl -s -X POST http://127.0.0.1:8090/v1/chat/completions -H 'Content-Type: application/json' -d @- \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); m=d["choices"][0]["message"]; print("content:", (m.get("content") or "")[:120]); print("reasoning field present:", "reasoning_content" in m or "reasoning" in m)'
done
```

Expected: the request without the switch may include reasoning; with `chat_template_kwargs` it must not, and the answer stays correct. If oMLX rejects the field with a 4xx, record that and Task 1 uses `{}` for `chatExtraBody` instead, noting why.

- [ ] **Step 4: Record the reference embedding for the parity fixture**

The MLX embedding server must be the one running (`scripts/switch-stack.sh status` shows mlx up). With both servers up:

```bash
cd /Users/seb/claude/PharmaLLM
python3 - <<'PY'
import json, math, urllib.request
TEXT = "PharmaLLM parity probe: air-gapped vault, CyberSense, GMP change control."
def embed(url, model):
    body = json.dumps({"model": model, "input": TEXT}).encode()
    req = urllib.request.Request(f"{url}/v1/embeddings", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["data"][0]["embedding"]
mlx = embed("http://localhost:8081", "mlx-community/Qwen3-Embedding-0.6B-8bit")
omlx = embed("http://127.0.0.1:8090", "mlx-community--Qwen3-Embedding-0.6B-8bit")
dot = sum(a*b for a, b in zip(mlx, omlx)); na = math.sqrt(sum(a*a for a in mlx)); nb = math.sqrt(sum(b*b for b in omlx))
print("dims", len(mlx), len(omlx), "cosine", round(dot/(na*nb), 6))
json.dump({"text": TEXT, "model": "mlx-community/Qwen3-Embedding-0.6B-8bit", "recorded": "2026-09-18", "vector": mlx},
          open("__tests__/fixtures/embedding-reference.json", "w"))
PY
```

Expected: 1024 dimensions on both and cosine ≥ 0.9999. The fixture written here is what Task 3 compares against.

- [ ] **Step 5: Stop oMLX and record the results**

```bash
kill "$(lsof -nP -iTCP:8090 -sTCP:LISTEN -t | head -1)"
du -sh ~/.omlx
```

Write `docs/superpowers/plans/2026-09-18-omlx-stack-verification.md` with each step's output: pinned SHA and version, model ids, cache-limit finding, thinking-switch result, parity cosine, cache size. Then:

```bash
git add docs/superpowers/plans/2026-09-18-omlx-stack-verification.md __tests__/fixtures/embedding-reference.json
git commit -m "docs: record oMLX verification and the embedding reference vector

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: The omlx stack entry

**Files:**
- Modify: `src/config/llm-stacks.ts`
- Modify: `__tests__/llm-stacks.test.ts`

**Interfaces:**
- Consumes: Task 0's verified model ids and thinking-switch result.
- Produces: `StackName = "ollama" | "mlx" | "omlx"`; `buildStacks(env).omlx` with `chatBaseUrl`/`embedBaseUrl` `env.OMLX_URL ?? "http://localhost:8090"`, `chromaCollection: "knowledge_base_mlx"`, `indexFile: ".index.mlx.json"`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/llm-stacks.test.ts`:

```ts
describe("omlx stack", () => {
  it("serves chat and embeddings from one server and shares the MLX index", () => {
    const { mlx, omlx } = buildStacks({});

    expect(omlx.name).toBe("omlx");
    expect(omlx.chatBaseUrl).toBe("http://localhost:8090");
    expect(omlx.embedBaseUrl).toBe(omlx.chatBaseUrl);
    expect(omlx.chatModel).toBe("mlx-community--Qwen3.8-27B-4bit");
    expect(omlx.embeddingModel).toBe("mlx-community--Qwen3-Embedding-0.6B-8bit");
    expect(omlx.embeddingDim).toBe(mlx.embeddingDim);
    expect(omlx.chromaCollection).toBe(mlx.chromaCollection);
    expect(omlx.indexFile).toBe(mlx.indexFile);
  });

  it("takes its URL from the environment", () => {
    expect(buildStacks({ OMLX_URL: "http://127.0.0.1:9100" }).omlx.chatBaseUrl).toBe("http://127.0.0.1:9100");
  });

  it("is selectable through LLM_PROVIDER", () => {
    expect(getActiveStack({ LLM_PROVIDER: "omlx" }).name).toBe("omlx");
  });

  it("rejects an unknown stack name and names all three", () => {
    expect(() => getActiveStack({ LLM_PROVIDER: "vllm" })).toThrow(/ollama.*mlx.*omlx/);
  });
});
```

If `__tests__/llm-stacks.test.ts` does not import `getActiveStack`, add it to the existing import from `../src/config/llm-stacks.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/llm-stacks.test.ts`
Expected: FAIL — `buildStacks({}).omlx` is undefined and `getActiveStack` throws for `"omlx"`.

- [ ] **Step 3: Add the stack**

In `src/config/llm-stacks.ts`:

- Change the type: `export type StackName = "ollama" | "mlx" | "omlx";`
- Add after the `mlx` entry, inside the returned object:

```ts
    // oMLX serves chat and embeddings from one process; its embeddings are identical to the MLX
    // server's (cosine 1.000000, see the verification doc), so it shares the MLX index
    omlx: {
      name: "omlx",
      chatBaseUrl: env.OMLX_URL ?? "http://localhost:8090",
      embedBaseUrl: env.OMLX_URL ?? "http://localhost:8090",
      chatModel: "mlx-community--Qwen3.8-27B-4bit",
      embeddingModel: "mlx-community--Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      chatExtraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
```

(If Task 0 Step 3 found the field is rejected, use `chatExtraBody: {}` and add a comment pointing at the verification doc.)

- Replace the guard in `getActiveStack`:

```ts
export function getActiveStack(env: NodeJS.ProcessEnv = process.env): StackConfig {
  const name = env.LLM_PROVIDER ?? "ollama";
  if (name !== "ollama" && name !== "mlx" && name !== "omlx") {
    throw new Error(`Invalid LLM_PROVIDER "${name}" (expected "ollama", "mlx" or "omlx")`);
  }
  return buildStacks(env)[name];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/llm-stacks.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: 177 tests pass; typechecks clean. If another test enumerates stack names and now fails, fix that test to include `omlx` and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add src/config/llm-stacks.ts __tests__/llm-stacks.test.ts
git commit -m "feat: add the omlx stack sharing the MLX index

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Run oMLX from switch-stack.sh

**Files:**
- Modify: `scripts/switch-stack.sh`
- Modify: `__tests__/switch-stack-config.test.ts`

**Interfaces:**
- Consumes: Task 1's stack entry; Task 0's `OMLX_VERSION`.
- Produces: `scripts/switch-stack.sh omlx`, `stop_other_stacks <target>`, `start_omlx`, `stop_omlx`, `OMLX_PORT=8090`, `OMLX_VENV="$PROJECT_DIR/python/omlx-venv"`, `data/run/omlx.pid`, `data/logs/omlx.log`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/switch-stack-config.test.ts`:

```ts
describe("switch-stack.sh omlx stack", () => {
  it("defines the venv, port and pinned version", () => {
    expect(script).toContain('OMLX_VENV="$PROJECT_DIR/python/omlx-venv"');
    expect(script).toContain('OMLX_PORT="8090"');
    expect(script).toMatch(/OMLX_VERSION="[0-9a-f]{7,40}"/);
  });

  it("starts oMLX with one server for chat and embeddings", () => {
    expect(script).toContain('"$OMLX_VENV/bin/omlx" serve --host 127.0.0.1 --port "$OMLX_PORT"');
    expect(script).toContain('--model-dir "$HF_CACHE"');
    expect(script).toContain('echo $! >"$RUN_DIR/omlx.pid"');
    expect(script).toContain('wait_http "http://localhost:$OMLX_PORT/v1/models" 180');
  });

  it("stops every stack except the target instead of assuming two", () => {
    expect(script).toContain("stop_other_stacks()");
    expect(script).not.toContain("other_stack()");
    expect(script).toContain('for other in ollama mlx omlx; do');
  });

  it("accepts omlx everywhere a stack name is taken", () => {
    expect(script).toContain("ollama|mlx|omlx) ;;");
    expect(script).toContain("ollama|mlx|omlx) switch_to");
  });
});

describe("switch-stack.sh omlx processes", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Runs `omlx-ports` with a stub `omlx` and stub `lsof`/`nc` absent, so only the echo path is exercised
  it("reports the omlx port in status output", () => {
    const dir = mkdtempSync(join(tmpdir(), "omlx-status-"));
    dirs.push(dir);
    const result = spawnSync("bash", ["-c", `grep -c 'omlx:\\$OMLX_PORT' ${JSON.stringify(join(process.cwd(), "scripts", "switch-stack.sh"))}`], {
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin", HOME: dir },
    });
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/switch-stack-config.test.ts`
Expected: FAIL — none of those strings exist yet, and `other_stack()` is still present.

- [ ] **Step 3: Add the oMLX process functions**

In `scripts/switch-stack.sh`, below the `MLX_PROMPT_CACHE_BYTES` line, add:

```bash
OMLX_VENV="$PROJECT_DIR/python/omlx-venv"
OMLX_PORT="8090"
# Pinned to the commit verified in docs/superpowers/plans/2026-09-18-omlx-stack-verification.md
OMLX_VERSION="cbc1a80"
OMLX_REPO="https://github.com/jundot/omlx"
```

(Replace `cbc1a80` with the SHA Task 0 recorded.)

After `stop_mlx()`/`start_mlx()`, add:

```bash
stop_omlx() {
  stop_pidfile omlx "$OMLX_PORT" ignore-foreign
}

start_omlx() {
  if port_open "$OMLX_PORT"; then
    project_listener_open "$OMLX_PORT" \
      || { log "Port $OMLX_PORT is used by another program — cannot start oMLX"; return 1; }
  else
    nohup "$OMLX_VENV/bin/omlx" serve --host 127.0.0.1 --port "$OMLX_PORT" \
      --model-dir "$HF_CACHE" >"$LOG_DIR/omlx.log" 2>&1 &
    echo $! >"$RUN_DIR/omlx.pid"
  fi
  wait_http "http://localhost:$OMLX_PORT/v1/models" 180 || { log "oMLX did not become ready"; return 1; }
}
```

- [ ] **Step 4: Teach the script three stacks**

1. `validate_stack`: replace `ollama|mlx) ;;` with `ollama|mlx|omlx) ;;` and the message with `(expected ollama, mlx or omlx)`.
2. Replace the whole `other_stack()` function with:

```bash
# Stop every stack except the target: with three stacks "the other one" is no longer a single value
stop_other_stacks() {
  local target="$1" other rc=0
  for other in ollama mlx omlx; do
    [ "$other" = "$target" ] && continue
    case "$other" in
      ollama) stop_ollama || rc=$? ;;
      mlx) stop_mlx || rc=$? ;;
      omlx) stop_omlx || rc=$? ;;
    esac
  done
  return "$rc"
}
```

3. In `switch_to` and `ensure_stack`, replace `stop_stack "$(other_stack "$target")"` with `stop_other_stacks "$target"`.
4. `start_stack` and `stop_stack` gain the third branch:

```bash
start_stack() {
  case "$1" in
    mlx) start_mlx ;;
    omlx) start_omlx ;;
    *) start_ollama && ensure_ollama_ctx ;;
  esac
}

stop_stack() {
  case "$1" in
    mlx) stop_mlx ;;
    omlx) stop_omlx ;;
    *) stop_ollama ;;
  esac
}
```

5. `models_ready`, add a branch:

```bash
    omlx)
      [ -x "$OMLX_VENV/bin/omlx" ] && hf_snapshot_present "$MLX_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
```

6. `warm_up`, add before the `else` of the mlx branch:

```bash
  elif [ "$1" = "omlx" ]; then
    chat_url="http://localhost:$OMLX_PORT"
    embed_url="$chat_url"
    chat_model="mlx-community--Qwen3.8-27B-4bit"
    embed_model="mlx-community--Qwen3-Embedding-0.6B-8bit"
    extra='"chat_template_kwargs":{"enable_thinking":false}'
```

7. `prepare`, after the MLX venv block:

```bash
  # oMLX venv: pinned, models come from the same Hugging Face cache
  if [ ! -x "$OMLX_VENV/bin/omlx" ]; then
    log "Installing oMLX $OMLX_VERSION into $OMLX_VENV"
    rm -rf "$PROJECT_DIR/python/omlx-src"
    git clone "$OMLX_REPO" "$PROJECT_DIR/python/omlx-src"
    (cd "$PROJECT_DIR/python/omlx-src" && git checkout -q "$OMLX_VERSION")
    "$MLX_PYTHON" -m venv "$OMLX_VENV"
    "$OMLX_VENV/bin/pip" install -q -e "$PROJECT_DIR/python/omlx-src"
  fi
```

8. `status`, in the port loop entry list add `"omlx:$OMLX_PORT"`, and after the loop:

```bash
  [ -d "$HOME/.omlx" ] && log "  omlx SSD cache: $(du -sh "$HOME/.omlx" 2>/dev/null | cut -f1)"
```

9. Usage header and dispatch: the first usage line becomes `scripts/switch-stack.sh ollama|mlx|omlx` and the case arm `ollama|mlx|omlx) switch_to "$1" ;;`. Keep the `sed -n '2,11p'` range correct: the header still has the same number of lines.

Add `python/omlx-src/` and `python/omlx-venv/` to `.gitignore` if `python/mlx-venv` is listed there; check first with `grep -n "mlx-venv" .gitignore`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- __tests__/switch-stack-config.test.ts && bash -n scripts/switch-stack.sh`
Expected: PASS, no syntax errors.

Run: `npm test`
Expected: 182 tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/switch-stack.sh __tests__/switch-stack-config.test.ts .gitignore
git commit -m "feat: run the omlx stack from switch-stack.sh

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Embedding parity guard

**Files:**
- Create: `scripts/lib/embedding-parity.py`
- Modify: `scripts/switch-stack.sh`
- Create: `__tests__/embedding-parity.test.ts`
- Uses: `__tests__/fixtures/embedding-reference.json` (committed in Task 0)

**Interfaces:**
- Consumes: Task 2's `start_omlx`.
- Produces: `scripts/lib/embedding-parity.py <base-url> <model> <fixture>` exiting 0 on cosine ≥ 0.9999, 1 otherwise, printing `cosine=<value>`; `check_embedding_parity` called in `start_stack` for omlx.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/embedding-parity.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "lib", "embedding-parity.py");
const fixturePath = join(process.cwd(), "__tests__", "fixtures", "embedding-reference.json");
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake embeddings endpoint returning whatever vector the test wants
async function startFakeEmbedder(vector: number[]): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: vector }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function run(url: string, fixture: string) {
  return spawnSync("/usr/bin/python3", [script, url, "test-model", fixture], { encoding: "utf-8" });
}

describe("embedding-parity.py", () => {
  it("passes when the vectors match the reference", async () => {
    const reference = JSON.parse(readFileSync(fixturePath, "utf-8")) as { vector: number[] };
    const url = await startFakeEmbedder(reference.vector);

    const result = run(url, fixturePath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cosine=1.0");
  });

  it("fails when the vectors have drifted", async () => {
    const reference = JSON.parse(readFileSync(fixturePath, "utf-8")) as { vector: number[] };
    const drifted = reference.vector.map((value, index) => (index % 3 === 0 ? value * -1 : value * 0.2));
    const url = await startFakeEmbedder(drifted);

    const result = run(url, fixturePath);

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/cosine=/);
  });

  it("fails loudly when the server is unreachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-"));
    dirs.push(dir);
    const fixture = join(dir, "ref.json");
    writeFileSync(fixture, JSON.stringify({ text: "probe", model: "m", vector: [1, 0, 0] }));

    const result = run("http://127.0.0.1:9", fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/embedding parity check failed/i);
  });
});

describe("switch-stack.sh parity guard", () => {
  it("checks parity after starting oMLX and before the app", () => {
    const shell = readFileSync(join(process.cwd(), "scripts", "switch-stack.sh"), "utf-8");
    expect(shell).toContain("check_embedding_parity()");
    expect(shell).toContain("scripts/lib/embedding-parity.py");
    expect(shell).toContain("start_omlx && check_embedding_parity");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/embedding-parity.test.ts`
Expected: FAIL — the Python script does not exist (spawn returns status 2 with "can't open file"), and the shell strings are missing.

- [ ] **Step 3: Write the parity script**

Create `scripts/lib/embedding-parity.py`:

```python
#!/usr/bin/env python3
"""Refuse to serve a stack whose embeddings no longer match the index it shares.

Usage: embedding-parity.py <base-url> <model> <fixture.json>
Exits 0 when cosine >= 0.9999 against the recorded reference vector, 1 otherwise.
"""
import json
import math
import sys
import urllib.request

MIN_COSINE = 0.9999


def main() -> int:
    base_url, model, fixture_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(fixture_path, encoding="utf-8") as handle:
        fixture = json.load(handle)
    body = json.dumps({"model": model, "input": fixture["text"]}).encode()
    request = urllib.request.Request(
        f"{base_url}/v1/embeddings", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            vector = json.loads(response.read())["data"][0]["embedding"]
    except Exception as error:  # noqa: BLE001 - any failure here must fail the switch
        print(f"embedding parity check failed: {error}", file=sys.stderr)
        return 1

    reference = fixture["vector"]
    if len(vector) != len(reference):
        print(f"embedding parity check failed: {len(vector)} dims, expected {len(reference)}", file=sys.stderr)
        return 1
    dot = sum(a * b for a, b in zip(vector, reference))
    norm = math.sqrt(sum(a * a for a in vector)) * math.sqrt(sum(b * b for b in reference))
    cosine = dot / norm if norm else 0.0
    print(f"cosine={round(cosine, 6)}")
    if cosine < MIN_COSINE:
        print(
            f"embedding parity check failed: cosine={round(cosine, 6)} < {MIN_COSINE}; "
            f"this stack shares an index built with {fixture['model']}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run `chmod +x scripts/lib/embedding-parity.py`.

- [ ] **Step 4: Call it from the switch**

In `scripts/switch-stack.sh`, after `start_omlx()`, add:

```bash
# The omlx stack shares the MLX index: serving it with drifted embeddings would silently poison retrieval
check_embedding_parity() {
  local out
  if out="$("$MLX_PYTHON" "$SCRIPT_DIR/lib/embedding-parity.py" \
      "http://localhost:$OMLX_PORT" "mlx-community--Qwen3-Embedding-0.6B-8bit" \
      "$PROJECT_DIR/__tests__/fixtures/embedding-reference.json" 2>&1)"; then
    log "Embedding parity ok (${out})"
    return 0
  fi
  log "Embedding parity check failed: $out"
  return 1
}
```

and change the omlx branch of `start_stack` to `omlx) start_omlx && check_embedding_parity ;;`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- __tests__/embedding-parity.test.ts && bash -n scripts/switch-stack.sh`
Expected: PASS.

Run: `npm test`
Expected: 185 tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/embedding-parity.py scripts/switch-stack.sh __tests__/embedding-parity.test.ts
git commit -m "feat: refuse to serve omlx when its embeddings drift from the shared index

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Stack switch state machine

**Files:**
- Create: `src/services/stack-switch.ts`
- Create: `__tests__/stack-switch.test.ts`

**Interfaces:**
- Consumes: `StackName` from Task 1.
- Produces:
  - `CONFIRM_WINDOW_MS = 5 * 60 * 1000`
  - `SwitchPhase`, `PendingSwitch { id, target, token, requestedAt, expiresAt }`, `SwitchProgress { phase, target, previous, startedAt, finishedAt?, error? }`
  - `SwitchOutcome = { ok: true; pending: PendingSwitch } | { ok: false; reason: "already_active" | "pending" | "benchmark" | "reindex"; message: string }`
  - `StackSwitchDeps { now(): number; newId(): string; newToken(): string; activeStack(): StackName; isBenchmarkActive(): boolean; runningJobs(): string[] }`
  - `createStackSwitch(deps): StackSwitch` with `request(target)`, `confirm(token)`, `pending()`
  - `parseProgress(value: unknown): SwitchProgress | null`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/stack-switch.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { CONFIRM_WINDOW_MS, createStackSwitch, parseProgress } from "../src/services/stack-switch.js";
import type { StackSwitchDeps } from "../src/services/stack-switch.js";

interface Harness {
  clock: { value: number };
  switcher: ReturnType<typeof createStackSwitch>;
  state: { active: "ollama" | "mlx" | "omlx"; benchmark: boolean; jobs: string[] };
}

function harness(): Harness {
  const clock = { value: 1_000 };
  const state = { active: "ollama" as const, benchmark: false, jobs: [] as string[] };
  let counter = 0;
  const deps: StackSwitchDeps = {
    now: () => clock.value,
    newId: () => `id-${++counter}`,
    newToken: () => `token-${counter}`,
    activeStack: () => state.active,
    isBenchmarkActive: () => state.benchmark,
    runningJobs: () => state.jobs,
  };
  return { clock, switcher: createStackSwitch(deps), state: state as Harness["state"] };
}

describe("request", () => {
  it("accepts a switch to another stack and issues a token with a 5 minute window", () => {
    const h = harness();

    const outcome = h.switcher.request("omlx");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pending.target).toBe("omlx");
    expect(outcome.pending.token).toBe("token-1");
    expect(outcome.pending.expiresAt).toBe(1_000 + CONFIRM_WINDOW_MS);
  });

  it("refuses a switch to the stack already running", () => {
    const h = harness();

    const outcome = h.switcher.request("ollama");

    expect(outcome).toEqual({ ok: false, reason: "already_active", message: "ollama is already the active stack" });
  });

  it("refuses a second request while one is pending", () => {
    const h = harness();
    h.switcher.request("mlx");

    const outcome = h.switcher.request("omlx");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("pending");
  });

  it("refuses while a benchmark runs", () => {
    const h = harness();
    h.state.benchmark = true;

    expect(h.switcher.request("mlx")).toEqual({
      ok: false,
      reason: "benchmark",
      message: "a benchmark is running; try again when it finishes",
    });
  });

  it("refuses while a reindex runs", () => {
    const h = harness();
    h.state.jobs = ["reindex"];

    const outcome = h.switcher.request("mlx");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("reindex");
  });

  it("allows a new request once the previous one expired", () => {
    const h = harness();
    h.switcher.request("mlx");
    h.clock.value += CONFIRM_WINDOW_MS + 1;

    expect(h.switcher.request("omlx").ok).toBe(true);
  });
});

describe("confirm", () => {
  it("consumes the token once", () => {
    const h = harness();
    const outcome = h.switcher.request("omlx");
    if (!outcome.ok) throw new Error("expected acceptance");

    expect(h.switcher.confirm(outcome.pending.token)?.target).toBe("omlx");
    expect(h.switcher.confirm(outcome.pending.token)).toBeNull();
    expect(h.switcher.pending()).toBeNull();
  });

  it("rejects an unknown or expired token", () => {
    const h = harness();
    const outcome = h.switcher.request("omlx");
    if (!outcome.ok) throw new Error("expected acceptance");

    expect(h.switcher.confirm("token-nope")).toBeNull();
    h.clock.value += CONFIRM_WINDOW_MS + 1;
    expect(h.switcher.confirm(outcome.pending.token)).toBeNull();
  });
});

describe("parseProgress", () => {
  it("reads a progress record the script wrote", () => {
    expect(
      parseProgress({ phase: "warming", target: "omlx", previous: "mlx", startedAt: 5 })
    ).toEqual({ phase: "warming", target: "omlx", previous: "mlx", startedAt: 5 });
  });

  it("returns null for anything malformed", () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress({ phase: "dancing", target: "omlx", previous: "mlx", startedAt: 5 })).toBeNull();
    expect(parseProgress({ phase: "ready", target: "nope", previous: "mlx", startedAt: 5 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/stack-switch.test.ts`
Expected: FAIL — cannot resolve `../src/services/stack-switch.js`.

- [ ] **Step 3: Write the state machine**

Create `src/services/stack-switch.ts`:

```ts
// Pending stack switches: a UI request becomes a one-time token, confirmed out of band through Telegram.
// Pure state plus pure parsing; the HTTP layer owns I/O and process spawning.

import type { StackName } from "../config/llm-stacks.js";

export const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

const PHASES = ["confirmed", "stopping", "starting", "warming", "indexing", "ready", "failed"] as const;
export type SwitchPhase = (typeof PHASES)[number];

const STACKS: readonly StackName[] = ["ollama", "mlx", "omlx"];

export interface PendingSwitch {
  id: string;
  target: StackName;
  token: string;
  requestedAt: number;
  expiresAt: number;
}

export interface SwitchProgress {
  phase: SwitchPhase;
  target: StackName;
  previous: StackName;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export type SwitchRefusalReason = "already_active" | "pending" | "benchmark" | "reindex";

export type SwitchOutcome =
  | { ok: true; pending: PendingSwitch }
  | { ok: false; reason: SwitchRefusalReason; message: string };

export interface StackSwitchDeps {
  now(): number;
  newId(): string;
  newToken(): string;
  activeStack(): StackName;
  isBenchmarkActive(): boolean;
  runningJobs(): string[];
}

export interface StackSwitch {
  request(target: StackName): SwitchOutcome;
  confirm(token: string): PendingSwitch | null;
  pending(): PendingSwitch | null;
}

function isStackName(value: unknown): value is StackName {
  return typeof value === "string" && (STACKS as readonly string[]).includes(value);
}

function isPhase(value: unknown): value is SwitchPhase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

export function parseProgress(value: unknown): SwitchProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isPhase(record.phase) || !isStackName(record.target) || !isStackName(record.previous)) return null;
  if (typeof record.startedAt !== "number") return null;
  const progress: SwitchProgress = {
    phase: record.phase,
    target: record.target,
    previous: record.previous,
    startedAt: record.startedAt,
  };
  if (typeof record.finishedAt === "number") progress.finishedAt = record.finishedAt;
  if (typeof record.error === "string") progress.error = record.error;
  return progress;
}

export function createStackSwitch(deps: StackSwitchDeps): StackSwitch {
  let current: PendingSwitch | null = null;

  const live = (): PendingSwitch | null => {
    if (current && current.expiresAt <= deps.now()) current = null;
    return current;
  };

  return {
    request(target) {
      if (target === deps.activeStack()) {
        return { ok: false, reason: "already_active", message: `${target} is already the active stack` };
      }
      if (live()) {
        return { ok: false, reason: "pending", message: "another switch is waiting for confirmation" };
      }
      if (deps.isBenchmarkActive()) {
        return { ok: false, reason: "benchmark", message: "a benchmark is running; try again when it finishes" };
      }
      if (deps.runningJobs().includes("reindex")) {
        return { ok: false, reason: "reindex", message: "a reindex is running; try again when it finishes" };
      }
      const requestedAt = deps.now();
      current = {
        id: deps.newId(),
        target,
        token: deps.newToken(),
        requestedAt,
        expiresAt: requestedAt + CONFIRM_WINDOW_MS,
      };
      return { ok: true, pending: current };
    },

    confirm(token) {
      const pending = live();
      if (!pending || pending.token !== token) return null;
      current = null;
      return pending;
    },

    pending() {
      return live();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/stack-switch.test.ts`
Expected: PASS (11 tests).

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: 193 tests pass; typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/stack-switch.ts __tests__/stack-switch.test.ts
git commit -m "feat: add the pending stack switch state machine

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Telegram notifications

**Files:**
- Create: `src/services/telegram-notify.ts`
- Create: `__tests__/telegram-notify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TelegramConfig { botToken, chatId }`, `readTelegramConfig(env)`, `TelegramError`, `TelegramSender = (text: string) => Promise<void>`, `createTelegramSender(config, fetchImpl?)`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/telegram-notify.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { createTelegramSender, readTelegramConfig, TelegramError } from "../src/services/telegram-notify.js";

const BOT_TOKEN = "123456:AA-secret-bot-token";
const CHAT_ID = "424242";

describe("readTelegramConfig", () => {
  it("reads both values from the environment", () => {
    expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
    });
  });

  it("treats blank or missing values as not configured", () => {
    expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      botToken: null,
      chatId: CHAT_ID,
    });
    expect(readTelegramConfig({})).toEqual({ botToken: null, chatId: null });
  });
});

describe("createTelegramSender", () => {
  it("posts the message to the bot API with the chat id in the body", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { ok: true, status: 200, text: async () => "{}" };
    };

    const send = createTelegramSender({ botToken: BOT_TOKEN, chatId: CHAT_ID }, fetchImpl);
    await send("switch to omlx?");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(calls[0].body).toEqual({ chat_id: CHAT_ID, text: "switch to omlx?", disable_web_page_preview: true });
  });

  it("throws a TelegramError without the token when the API refuses", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });

    const send = createTelegramSender({ botToken: BOT_TOKEN, chatId: CHAT_ID }, fetchImpl);

    await expect(send("hello")).rejects.toThrow(TelegramError);
    await expect(send("hello")).rejects.toThrow(/telegram sendMessage failed \(401\)/);
    await expect(send("hello")).rejects.not.toThrow(new RegExp(BOT_TOKEN));
  });

  it("throws when it is not configured", async () => {
    const send = createTelegramSender({ botToken: null, chatId: CHAT_ID }, async () => {
      throw new Error("must not be called");
    });

    await expect(send("hello")).rejects.toThrow(/not configured/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/telegram-notify.test.ts`
Expected: FAIL — cannot resolve `../src/services/telegram-notify.js`.

- [ ] **Step 3: Write the sender**

Create `src/services/telegram-notify.ts`:

```ts
// Outbound-only Telegram messages. The app never polls for updates: Hermes' gateway is the single
// allowed consumer of that bot's getUpdates stream.

export interface TelegramConfig {
  botToken: string | null;
  chatId: string | null;
}

export interface TelegramResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface TelegramFetch {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<TelegramResponse>;
}

export interface TelegramSender {
  (text: string): Promise<void>;
}

export class TelegramError extends Error {}

export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    chatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

export function isTelegramConfigured(config: TelegramConfig): boolean {
  return config.botToken !== null && config.chatId !== null;
}

const defaultFetch: TelegramFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) as unknown as Promise<TelegramResponse>;

export function createTelegramSender(config: TelegramConfig, fetchImpl: TelegramFetch = defaultFetch): TelegramSender {
  return async (text: string) => {
    if (!isTelegramConfigured(config)) {
      throw new TelegramError("telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    }
    let response: TelegramResponse;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
      });
    } catch (err) {
      // Never include the URL: it carries the bot token
      throw new TelegramError(`telegram sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new TelegramError(`telegram sendMessage failed (${response.status})`);
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/telegram-notify.test.ts`
Expected: PASS (5 tests).

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: 197 tests pass; typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegram-notify.ts __tests__/telegram-notify.test.ts
git commit -m "feat: add outbound Telegram notifications

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Stack routes

**Files:**
- Create: `src/api/stack.ts`
- Modify: `src/api/auth.ts`
- Modify: `src/server.ts`
- Create: `__tests__/stack-routes.test.ts`
- Modify: `__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `createStackSwitch`, `parseProgress`, `CONFIRM_WINDOW_MS` (Task 4); `TelegramSender`, `TelegramError` (Task 5); `StackName` (Task 1).
- Produces: `createStackRouter(deps: StackRouterDeps)` and its default export; `StackRouterDeps { switcher, sendTelegram, spawnSwitch(target), activeStack(), readProgress(), confirmBaseUrl(), telegramConfigured() }`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/stack-routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStackRouter } from "../src/api/stack.js";
import { createStackSwitch } from "../src/services/stack-switch.js";
import type { StackName } from "../src/config/llm-stacks.js";
import type { SwitchProgress } from "../src/services/stack-switch.js";

const BOT_MESSAGE_TOKEN_PATTERN = /token=([a-zA-Z0-9_-]+)/;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
});

interface Fixture {
  url: string;
  messages: string[];
  spawned: StackName[];
  state: { active: StackName; benchmark: boolean; jobs: string[]; progress: SwitchProgress | null; configured: boolean; sendFails: boolean };
}

async function startApp(): Promise<Fixture> {
  const state = {
    active: "ollama" as StackName,
    benchmark: false,
    jobs: [] as string[],
    progress: null as SwitchProgress | null,
    configured: true,
    sendFails: false,
  };
  const messages: string[] = [];
  const spawned: StackName[] = [];
  let counter = 0;
  const switcher = createStackSwitch({
    now: () => Date.now(),
    newId: () => `id-${++counter}`,
    newToken: () => `tok-${counter}`,
    activeStack: () => state.active,
    isBenchmarkActive: () => state.benchmark,
    runningJobs: () => state.jobs,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/stack",
    createStackRouter({
      switcher,
      sendTelegram: async (text: string) => {
        if (state.sendFails) throw new Error("telegram sendMessage failed (401)");
        messages.push(text);
      },
      spawnSwitch: (target: StackName) => {
        spawned.push(target);
      },
      activeStack: () => state.active,
      readProgress: () => state.progress,
      confirmBaseUrl: () => "https://mac:3443",
      telegramConfigured: () => state.configured,
    })
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, messages, spawned, state };
}

async function post(url: string, stack: string) {
  const res = await fetch(`${url}/api/stack/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stack }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/stack/switch", () => {
  it("accepts a switch, sends exactly one Telegram message with a confirm link, and starts nothing yet", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(202);
    expect(body.status).toBe("pending_confirmation");
    expect(typeof body.expires_at).toBe("number");
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]).toContain("omlx");
    expect(fixture.messages[0]).toMatch(BOT_MESSAGE_TOKEN_PATTERN);
    expect(fixture.messages[0]).toContain("https://mac:3443/api/stack/confirm?token=");
    expect(fixture.spawned).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
  });

  it("refuses an unknown stack name", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "vllm");

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/ollama, mlx or omlx/);
    expect(fixture.messages).toEqual([]);
  });

  it("passes the state machine's refusal through as 409", async () => {
    const fixture = await startApp();
    fixture.state.jobs = ["reindex"];

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("reindex");
    expect(fixture.messages).toEqual([]);
  });

  it("refuses when Telegram is not configured", async () => {
    const fixture = await startApp();
    fixture.state.configured = false;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("telegram_unconfigured");
    expect(fixture.spawned).toEqual([]);
  });

  it("leaves no pending switch when the message cannot be sent", async () => {
    const fixture = await startApp();
    fixture.state.sendFails = true;

    const refused = await post(fixture.url, "omlx");

    expect(refused.status).toBe(502);
    expect(String(refused.body.error)).toMatch(/Could not send the Telegram confirmation/);
    expect(fixture.spawned).toEqual([]);

    // Nobody was asked, so nobody can confirm: the next request must be accepted
    fixture.state.sendFails = false;
    expect((await post(fixture.url, "omlx")).status).toBe(202);
  });
});

describe("GET /api/stack/confirm", () => {
  it("spawns the switch once for a good token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    const token = BOT_MESSAGE_TOKEN_PATTERN.exec(fixture.messages[0])?.[1] ?? "";

    const first = await fetch(`${fixture.url}/api/stack/confirm?token=${token}`);
    const second = await fetch(`${fixture.url}/api/stack/confirm?token=${token}`);

    expect(first.status).toBe(200);
    expect((await first.text()).toLowerCase()).toContain("omlx");
    expect(second.status).toBe(410);
    expect(fixture.spawned).toEqual(["omlx"]);
  });

  it("refuses an unknown token without spawning", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/stack/confirm?token=nope`);

    expect(res.status).toBe(410);
    expect(fixture.spawned).toEqual([]);
  });
});

describe("GET /api/stack/status", () => {
  it("reports the active stack, the pending target and the progress, never the token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    fixture.state.progress = { phase: "warming", target: "omlx", previous: "ollama", startedAt: 10 };

    const res = await fetch(`${fixture.url}/api/stack/status`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.active).toBe("ollama");
    expect(body.stacks).toEqual(["ollama", "mlx", "omlx"]);
    expect((body.pending as Record<string, unknown>).target).toBe("omlx");
    expect((body.progress as Record<string, unknown>).phase).toBe("warming");
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
  });
});
```

Append to `__tests__/auth.test.ts`, inside the `isProtectedRequest` describe:

```ts
  it("keeps the stack switch routes open for the browser UI", () => {
    expect(isProtectedRequest("POST", "/api/stack/switch")).toBe(false);
    expect(isProtectedRequest("GET", "/api/stack/confirm")).toBe(false);
    expect(isProtectedRequest("GET", "/api/stack/status")).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/stack-routes.test.ts __tests__/auth.test.ts`
Expected: FAIL — `../src/api/stack.js` does not exist, and the three stack routes are still protected.

- [ ] **Step 3: Write the router**

Create `src/api/stack.ts`:

```ts
// Stack switching for the browser UI. The route itself needs no token: approval arrives out of band,
// as a one-time link in a Telegram message. The spawned script outlives the app it restarts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { getActiveStack } from "../config/llm-stacks.js";
import type { StackName } from "../config/llm-stacks.js";
import { getRunningJobs, isBenchmarkActive } from "../services/bench-mode.js";
import { createStackSwitch, parseProgress } from "../services/stack-switch.js";
import type { StackSwitch, SwitchProgress } from "../services/stack-switch.js";
import { createTelegramSender, isTelegramConfigured, readTelegramConfig } from "../services/telegram-notify.js";
import type { TelegramSender } from "../services/telegram-notify.js";

const STACKS: readonly StackName[] = ["ollama", "mlx", "omlx"];
const PROGRESS_FILE = join(process.cwd(), "data", "run", "stack-switch.json");

export interface StackRouterDeps {
  switcher: StackSwitch;
  sendTelegram: TelegramSender;
  spawnSwitch(target: StackName): void;
  activeStack(): StackName;
  readProgress(): SwitchProgress | null;
  confirmBaseUrl(): string;
  telegramConfigured(): boolean;
}

function isStackName(value: unknown): value is StackName {
  return typeof value === "string" && (STACKS as readonly string[]).includes(value);
}

export function createStackRouter(deps: StackRouterDeps): Router {
  const router = Router();

  router.post("/switch", async (req: Request, res: Response): Promise<void> => {
    const target = (req.body as { stack?: unknown } | undefined)?.stack;
    if (!isStackName(target)) {
      res.status(400).json({ error: 'Unknown stack (expected "ollama", "mlx" or "omlx")' });
      return;
    }
    if (!deps.telegramConfigured()) {
      res.status(409).json({
        reason: "telegram_unconfigured",
        error: "Telegram confirmation is not configured (scripts/switch-stack.sh telegram)",
      });
      return;
    }
    const outcome = deps.switcher.request(target);
    if (!outcome.ok) {
      res.status(409).json({ reason: outcome.reason, error: outcome.message });
      return;
    }
    const link = `${deps.confirmBaseUrl()}/api/stack/confirm?token=${outcome.pending.token}`;
    try {
      await deps.sendTelegram(
        `PharmaLLM: switch the LLM stack from ${deps.activeStack()} to ${target}?\n` +
          `Confirm within 5 minutes:\n${link}\n` +
          `If you did not ask for this, ignore this message and nothing happens.`
      );
    } catch (err) {
      // Drop the pending switch: nobody was asked, so nobody can confirm
      deps.switcher.confirm(outcome.pending.token);
      res.status(502).json({ error: `Could not send the Telegram confirmation: ${err instanceof Error ? err.message : "unknown error"}` });
      return;
    }
    res.status(202).json({
      status: "pending_confirmation",
      target,
      expires_at: outcome.pending.expiresAt,
    });
  });

  router.get("/confirm", (req: Request, res: Response): void => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const pending = deps.switcher.confirm(token);
    if (!pending) {
      res.status(410).type("html").send("<h1>Link expired</h1><p>Request the switch again from PharmaLLM.</p>");
      return;
    }
    deps.spawnSwitch(pending.target);
    res
      .status(200)
      .type("html")
      .send(`<h1>Switching to ${pending.target}</h1><p>PharmaLLM restarts in a moment. You can close this page.</p>`);
  });

  router.get("/status", (_req: Request, res: Response): void => {
    const pending = deps.switcher.pending();
    res.json({
      active: deps.activeStack(),
      stacks: STACKS,
      telegram_configured: deps.telegramConfigured(),
      pending: pending ? { target: pending.target, expires_at: pending.expiresAt } : null,
      progress: deps.readProgress(),
    });
  });

  return router;
}

function readProgressFile(): SwitchProgress | null {
  try {
    return parseProgress(JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as unknown);
  } catch {
    return null;
  }
}

const telegramConfig = readTelegramConfig();

export default createStackRouter({
  switcher: createStackSwitch({
    now: () => Date.now(),
    newId: () => randomUUID(),
    newToken: () => randomUUID().replace(/-/g, ""),
    activeStack: () => getActiveStack().name,
    isBenchmarkActive: () => isBenchmarkActive(),
    runningJobs: () => getRunningJobs(),
  }),
  sendTelegram: createTelegramSender(telegramConfig),
  spawnSwitch: (target) => {
    // Detached: switch-stack.sh stops this very app, so the child must outlive it
    const child = spawn(join(process.cwd(), "scripts", "switch-stack.sh"), [target], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  },
  activeStack: () => getActiveStack().name,
  readProgress: readProgressFile,
  confirmBaseUrl: () => process.env.PHARMALLM_PUBLIC_URL ?? "http://localhost:3000",
  telegramConfigured: () => isTelegramConfigured(telegramConfig),
});
```

- [ ] **Step 4: Mount it and open the routes**

In `src/api/auth.ts`, add to `BROWSER_ROUTES`:

```ts
  ["POST", "/api/stack/switch"],
  ["GET", "/api/stack/confirm"],
  ["GET", "/api/stack/status"],
```

In `src/server.ts`, add the import beside the other routers (`import stackRouter from "./api/stack.js";`) and the mount directly after the `/api/bench` line:

```ts
app.use("/api/stack", stackRouter);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- __tests__/stack-routes.test.ts __tests__/auth.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: 204 tests pass; typechecks clean.

- [ ] **Step 6: Commit**

```bash
git add src/api/stack.ts src/api/auth.ts src/server.ts __tests__/stack-routes.test.ts __tests__/auth.test.ts
git commit -m "feat: add stack switch routes confirmed through Telegram

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Switch progress and Telegram credentials in the script

**Files:**
- Modify: `scripts/switch-stack.sh`
- Modify: `__tests__/switch-stack-config.test.ts`

**Interfaces:**
- Consumes: Task 4's phase names; Task 6's `readProgressFile` path.
- Produces: `data/run/stack-switch.json` written through the phases; `scripts/switch-stack.sh telegram` creating `data/run/telegram-bot-token` and `data/run/telegram-chat-id`; `start_app` exporting `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `PHARMALLM_PUBLIC_URL`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/switch-stack-config.test.ts`:

```ts
describe("switch-stack.sh switch progress", () => {
  it("writes every phase of a switch to the progress file", () => {
    expect(script).toContain('SWITCH_FILE="$RUN_DIR/stack-switch.json"');
    for (const phase of ["stopping", "starting", "warming", "indexing", "ready", "failed"]) {
      expect(script).toContain(`write_switch_phase ${phase}`);
    }
  });

  it("sends a Telegram completion message when the switch ends", () => {
    expect(script).toContain("notify_switch_result()");
    expect(script).toContain("api.telegram.org/bot");
    expect(script).toContain("notify_switch_result ready");
    expect(script).toContain("notify_switch_result failed");
  });

  it("passes the Telegram credentials and public URL to the app", () => {
    expect(script).toContain('TELEGRAM_BOT_TOKEN="$(telegram_value bot-token)"');
    expect(script).toContain('TELEGRAM_CHAT_ID="$(telegram_value chat-id)"');
    expect(script).toContain('PHARMALLM_PUBLIC_URL="${PHARMALLM_PUBLIC_URL:-http://localhost:$APP_PORT}"');
  });
});

describe("switch-stack.sh telegram command", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stores both values with owner-only permissions and never prints them", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    dirs.push(dir);

    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "telegram"], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        TELEGRAM_BOT_TOKEN: "123456:AA-secret",
        TELEGRAM_CHAT_ID: "424242",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "run", "telegram-bot-token"), "utf-8").trim()).toBe("123456:AA-secret");
    expect(readFileSync(join(dir, "run", "telegram-chat-id"), "utf-8").trim()).toBe("424242");
    expect(statSync(join(dir, "run", "telegram-bot-token")).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain("123456:AA-secret");
  });
});
```

Add `statSync` to the `node:fs` import in that file if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/switch-stack-config.test.ts`
Expected: FAIL — none of the new strings exist and the `telegram` command prints usage with status 1.

- [ ] **Step 3: Add progress writes and the telegram command**

In `scripts/switch-stack.sh`, below `MCP_TOKEN_FILE`, add:

```bash
SWITCH_FILE="$RUN_DIR/stack-switch.json"
TELEGRAM_BOT_TOKEN_FILE="$RUN_DIR/telegram-bot-token"
TELEGRAM_CHAT_ID_FILE="$RUN_DIR/telegram-chat-id"
```

After `api_token()`, add:

```bash
# The UI polls this file while the app is down mid-switch
write_switch_phase() {
  local phase="$1" error="${2:-}" target="${SWITCH_TARGET:-}" previous="${SWITCH_PREVIOUS:-}"
  [ -n "$target" ] || return 0
  PHASE="$phase" TARGET="$target" PREVIOUS="$previous" STARTED="${SWITCH_STARTED:-0}" ERROR="$error" \
    python3 - "$SWITCH_FILE" <<'PY'
import json, os, sys
record = {"phase": os.environ["PHASE"], "target": os.environ["TARGET"],
          "previous": os.environ["PREVIOUS"], "startedAt": int(os.environ["STARTED"])}
if os.environ["PHASE"] in ("ready", "failed"):
    import time
    record["finishedAt"] = int(time.time() * 1000)
if os.environ.get("ERROR"):
    record["error"] = os.environ["ERROR"]
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(record, handle)
PY
}

telegram_value() {
  local file="$RUN_DIR/telegram-$1"
  if [ -s "$file" ]; then tr -d '[:space:]' <"$file"; fi
}

# Credentials the app uses to ask for confirmation of a UI-triggered switch
ensure_telegram() {
  local token="${TELEGRAM_BOT_TOKEN:-}" chat="${TELEGRAM_CHAT_ID:-}"
  if [ -z "$token" ] && [ -t 0 ]; then read -rs -p "Telegram bot token: " token; echo >&2; fi
  if [ -z "$chat" ] && [ -t 0 ]; then read -r -p "Telegram chat id: " chat; fi
  [ -n "$token" ] && [ -n "$chat" ] || { log "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or run this on a terminal"; exit 1; }
  (umask 077 && printf '%s\n' "$token" >"$TELEGRAM_BOT_TOKEN_FILE")
  (umask 077 && printf '%s\n' "$chat" >"$TELEGRAM_CHAT_ID_FILE")
  chmod 600 "$TELEGRAM_BOT_TOKEN_FILE" "$TELEGRAM_CHAT_ID_FILE"
  log "Stored Telegram credentials in $RUN_DIR (mode 600)"
}
```

After `telegram_value()`, add the completion notice. The app is restarting when a switch ends, so the script is the only thing that can tell the user:

```bash
# Tell the user how the switch ended: the app is mid-restart and cannot send this itself
notify_switch_result() {
  local phase="$1" token chat text elapsed
  token="$(telegram_value bot-token)"; chat="$(telegram_value chat-id)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  elapsed=$(( ($(date +%s) * 1000 - ${SWITCH_STARTED:-0}) / 1000 ))
  if [ "$phase" = "ready" ]; then
    text="PharmaLLM: ${SWITCH_TARGET} stack is ready (${elapsed}s)."
  else
    text="PharmaLLM: switch to ${SWITCH_TARGET} failed after ${elapsed}s; ${SWITCH_PREVIOUS} is being restored."
  fi
  curl -sS -m 10 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -H 'Content-Type: application/json' \
    --data-binary "$(TEXT="$text" CHAT="$chat" python3 -c 'import json,os;print(json.dumps({"chat_id":os.environ["CHAT"],"text":os.environ["TEXT"]}))')" \
    || log "Could not send the Telegram completion message"
}
```

In `switch_to`, call it beside each terminal phase: `write_switch_phase ready` is followed by `notify_switch_result ready`, and `write_switch_phase failed "$target did not come up"` by `notify_switch_result failed`.

In `start_app`, extend the environment prefix:

```bash
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" PHARMALLM_API_TOKEN="$(api_token)" \
    TELEGRAM_BOT_TOKEN="$(telegram_value bot-token)" TELEGRAM_CHAT_ID="$(telegram_value chat-id)" \
    PHARMALLM_PUBLIC_URL="${PHARMALLM_PUBLIC_URL:-http://localhost:$APP_PORT}" \
    nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
```

In `switch_to`, set the context and write the phases:

```bash
switch_to() {
  local target="$1" previous
  previous="$(active_stack)"
  validate_stack "$target"
  models_ready "$target" || { log "Models for $target are missing. Run: scripts/switch-stack.sh prepare"; exit 1; }
  ensure_chromadb

  SWITCH_TARGET="$target"; SWITCH_PREVIOUS="$previous"; SWITCH_STARTED="$(($(date +%s) * 1000))"
  log "Switching: $previous -> $target"
  write_switch_phase stopping
  stop_app
  stop_other_stacks "$target"

  write_switch_phase starting
  if start_stack "$target"; then
    write_switch_phase warming
    if warm_up "$target"; then
      write_switch_phase indexing
      if ensure_index "$target" && start_app "$target"; then
        echo "$target" >"$RUN_DIR/active-stack"
        write_switch_phase ready
        log "Active stack: $target"
        return 0
      fi
    fi
  fi
  write_switch_phase failed "$target did not come up"
```

Everything after that line — `show_logs`, the rollback to `$previous` and the final `exit 1` — stays exactly as it is today.

Add the dispatch arm `telegram) ensure_telegram ;;` beside `token)`, extend the usage header with

```bash
#   scripts/switch-stack.sh telegram                 store the Telegram credentials used to confirm UI switches
```

and widen the usage range to `sed -n '2,12p'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/switch-stack-config.test.ts && bash -n scripts/switch-stack.sh`
Expected: PASS.

Run: `npm test`
Expected: 208 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/switch-stack.sh __tests__/switch-stack-config.test.ts
git commit -m "feat: report switch progress and store the Telegram credentials

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The UI stack selector

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Create: `src/services/switch-labels.ts`
- Create: `__tests__/switch-labels.test.ts`

**Interfaces:**
- Consumes: `/api/stack/status` and `/api/stack/switch` from Task 6.
- Produces: `describeSwitch(status)` returning the line the UI shows, shared by tests and the browser through a small script tag.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/switch-labels.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { describeSwitch } from "../src/services/switch-labels.js";

describe("describeSwitch", () => {
  it("names the active stack when nothing is happening", () => {
    expect(describeSwitch({ active: "mlx", pending: null, progress: null })).toBe("MLX stack active");
  });

  it("asks the user to confirm while a request is pending", () => {
    expect(
      describeSwitch({ active: "ollama", pending: { target: "omlx", expires_at: 0 }, progress: null })
    ).toBe("Confirm the switch to OMLX in Telegram");
  });

  it("describes each phase of a running switch", () => {
    const base = { active: "ollama" as const, pending: null };
    expect(describeSwitch({ ...base, progress: { phase: "stopping", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: stopping the current stack");
    expect(describeSwitch({ ...base, progress: { phase: "warming", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: warming up the model");
    expect(describeSwitch({ ...base, progress: { phase: "indexing", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: checking the indexes");
  });

  it("reports readiness with the elapsed time", () => {
    expect(
      describeSwitch({
        active: "omlx",
        pending: null,
        progress: { phase: "ready", target: "omlx", previous: "ollama", startedAt: 1_000, finishedAt: 97_000 },
      })
    ).toBe("OMLX stack ready (96 s)");
  });

  it("reports a failure with its reason", () => {
    expect(
      describeSwitch({
        active: "ollama",
        pending: null,
        progress: { phase: "failed", target: "omlx", previous: "ollama", startedAt: 0, error: "omlx did not come up" },
      })
    ).toBe("Switch to OMLX failed: omlx did not come up");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/switch-labels.test.ts`
Expected: FAIL — cannot resolve `../src/services/switch-labels.js`.

- [ ] **Step 3: Write the label helper**

Create `src/services/switch-labels.ts`:

```ts
// One sentence describing where a stack switch has got to, shared by the UI and its tests.

import type { StackName } from "../config/llm-stacks.js";
import type { SwitchProgress } from "./stack-switch.js";

export interface SwitchStatus {
  active: StackName;
  pending: { target: StackName; expires_at: number } | null;
  progress: SwitchProgress | null;
}

const PHASE_TEXT: Record<string, string> = {
  confirmed: "starting",
  stopping: "stopping the current stack",
  starting: "starting the server",
  warming: "warming up the model",
  indexing: "checking the indexes",
};

export function describeSwitch(status: SwitchStatus): string {
  if (status.pending) return `Confirm the switch to ${status.pending.target.toUpperCase()} in Telegram`;
  const progress = status.progress;
  if (progress && progress.phase === "failed") {
    return `Switch to ${progress.target.toUpperCase()} failed: ${progress.error ?? "unknown error"}`;
  }
  if (progress && progress.phase === "ready" && progress.finishedAt) {
    const seconds = Math.round((progress.finishedAt - progress.startedAt) / 1000);
    return `${progress.target.toUpperCase()} stack ready (${seconds} s)`;
  }
  if (progress && PHASE_TEXT[progress.phase]) {
    return `Switching to ${progress.target.toUpperCase()}: ${PHASE_TEXT[progress.phase]}`;
  }
  return `${status.active.toUpperCase()} stack active`;
}
```

- [ ] **Step 4: Add the selector to the page**

In `public/index.html`, inside `header-controls`, before the model selector:

```html
        <select id="stack-select" title="LLM stack (deployment environment)">
          <option value="ollama">Ollama</option>
        </select>
```

- [ ] **Step 5: Wire it up**

In `public/app.js`, add `const stackSelect = document.getElementById("stack-select");` beside the other element lookups, then append:

```js
// Stack switching: the request needs a Telegram confirmation, so the UI waits and then follows the switch
const STACK_LABELS = { ollama: "Ollama", mlx: "MLX", omlx: "oMLX" };
let stackPollTimer = null;
let lastKnownActive = null;

function renderStackStatus(status) {
  const options = (status.stacks || ["ollama", "mlx", "omlx"])
    .map((name) => {
      const selected = (status.pending ? status.pending.target : status.active) === name ? " selected" : "";
      return `<option value="${name}"${selected}>${STACK_LABELS[name] || name}</option>`;
    })
    .join("");
  if (stackSelect.innerHTML !== options) stackSelect.innerHTML = options;
  stackSelect.disabled = Boolean(status.pending) || !status.telegram_configured;
  stackSelect.title = status.telegram_configured
    ? "LLM stack (deployment environment)"
    : "Telegram confirmation not configured - run scripts/switch-stack.sh telegram";

  const phase = status.progress && status.progress.phase;
  const busy = Boolean(status.pending) || (phase && phase !== "ready" && phase !== "failed");
  setStatus(describeStackStatus(status), phase === "failed" ? "error" : busy ? "info" : "success");

  if (status.active !== lastKnownActive) {
    lastKnownActive = status.active;
    loadModels();
  }
  return busy;
}

// Same wording as src/services/switch-labels.ts. The browser cannot import TypeScript, so this is a
// deliberate second copy; __tests__/switch-labels.test.ts pins the wording both must produce
function describeStackStatus(status) {
  if (status.pending) return `Confirm the switch to ${status.pending.target.toUpperCase()} in Telegram`;
  const p = status.progress;
  if (p && p.phase === "failed") return `Switch to ${p.target.toUpperCase()} failed: ${p.error || "unknown error"}`;
  if (p && p.phase === "ready" && p.finishedAt) {
    return `${p.target.toUpperCase()} stack ready (${Math.round((p.finishedAt - p.startedAt) / 1000)} s)`;
  }
  const text = { confirmed: "starting", stopping: "stopping the current stack", starting: "starting the server",
                 warming: "warming up the model", indexing: "checking the indexes" };
  if (p && text[p.phase]) return `Switching to ${p.target.toUpperCase()}: ${text[p.phase]}`;
  return `${status.active.toUpperCase()} stack active`;
}

async function pollStackStatus() {
  try {
    const res = await fetch("/api/stack/status");
    if (!res.ok) return true;
    return renderStackStatus(await res.json());
  } catch {
    // The app restarts mid-switch: keep polling rather than reporting an error
    setStatus("Switching stack: waiting for PharmaLLM to come back", "info");
    return true;
  }
}

function watchStackSwitch() {
  if (stackPollTimer) return;
  stackPollTimer = setInterval(async () => {
    const busy = await pollStackStatus();
    if (!busy) {
      clearInterval(stackPollTimer);
      stackPollTimer = null;
    }
  }, 3000);
}

stackSelect.addEventListener("change", async () => {
  const target = stackSelect.value;
  stackSelect.disabled = true;
  try {
    const res = await fetch("/api/stack/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: target }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Stack switch refused", "error");
      await pollStackStatus();
      return;
    }
    setStatus(`Confirm the switch to ${target.toUpperCase()} in Telegram`, "info");
    watchStackSwitch();
  } catch {
    setStatus("Could not reach PharmaLLM", "error");
  }
});

pollStackStatus().then((busy) => {
  if (busy) watchStackSwitch();
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- __tests__/switch-labels.test.ts`
Expected: PASS (6 tests).

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: 210 tests pass; typechecks clean.

Check the page still parses: `node -e "const {readFileSync}=require('fs'); new Function(readFileSync('public/app.js','utf8')); console.log('app.js parses')"`

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js src/services/switch-labels.ts __tests__/switch-labels.test.ts
git commit -m "feat: switch stacks from the web UI

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`
- Modify: `hermes/README.md`

- [ ] **Step 1: Update the stack sections of README.md**

In "Choose Your Stack", replace the two-stack framing with three: add an `oMLX` column or row wherever `Ollama` and `MLX` are listed, describing it as "one server for chat and embeddings, shares the MLX index, restores long prompts from SSD after a restart". Add the commands:

```bash
scripts/switch-stack.sh prepare          # also installs the oMLX venv
scripts/switch-stack.sh omlx             # third stack, port 8090
scripts/switch-stack.sh telegram         # credentials for UI-confirmed switches
```

- [ ] **Step 2: Document switching from the UI**

Add a subsection under "Choose Your Stack":

````markdown
### Switching from the web UI

The header has a stack selector next to the model selector. Choosing a different stack does not switch immediately: PharmaLLM sends a Telegram message with a one-time confirmation link, valid for 5 minutes. Tapping it starts the switch; ignoring it reverts the selector. The UI then follows the switch (stopping, starting, warming up, checking indexes) and shows the new stack with how long it took, and Telegram gets a completion message.

The route itself needs no token, because approval comes from the Telegram link. Store the credentials once:

```bash
scripts/switch-stack.sh telegram         # prompts for the bot token and your chat id, stores them at mode 600
```

Without them the selector is disabled and says so. A switch is refused while a benchmark or a reindex is running, or when the stack is already active.
````

- [ ] **Step 3: Add the parity note**

In the same section, one paragraph: the omlx stack shares the MLX index and ChromaDB collection because their embeddings are identical (cosine 1.000000); every start re-checks that against `__tests__/fixtures/embedding-reference.json` and refuses to serve below 0.9999, so a future oMLX upgrade cannot silently poison retrieval.

- [ ] **Step 4: Mention the third stack in hermes/README.md**

One line in the operations table: Hermes follows the active stack, so `scripts/switch-stack.sh omlx` also moves the agent onto oMLX with no Hermes change.

- [ ] **Step 5: Commit**

```bash
git add README.md hermes/README.md
git commit -m "docs: document the omlx stack and UI switching

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Live verification (controller, with the user)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-18-omlx-stack-verification.md`

- [ ] **Step 1: Install the venv and switch to omlx from the command line**

```bash
scripts/switch-stack.sh prepare
scripts/switch-stack.sh omlx
curl -s localhost:3000/api/health | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["stack"], d["status"])'
curl -s localhost:3000/api/chat/models | head -c 200
```

Expected: `omlx healthy`, the parity line `Embedding parity ok (cosine=1.0)` in the switch output, and no reindex (the MLX index is reused).

- [ ] **Step 2: Prove retrieval works against the shared index**

```bash
T="$(cat data/run/api-token)"
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"query":"Dell PowerProtect Cyber Recovery","topK":3}' localhost:3000/api/knowledge/search \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["results"]), "chunks;", d["results"][0]["source"])'
```

Expected: 3 chunks from the same sources the MLX stack returns.

- [ ] **Step 3: Store the Telegram credentials**

Ask the user to run it themselves so the values never enter the conversation:

```bash
scripts/switch-stack.sh telegram
```

Then `ls -l data/run/telegram-*` shows two files at `-rw-------`.

- [ ] **Step 4: A UI switch, end to end**

Ask the user to open the UI, choose `MLX`, and confirm from Telegram. Record from the logs: the message arriving, the phases in `data/run/stack-switch.json`, the ready state and the elapsed time, plus the completion message.

- [ ] **Step 5: The revert path**

Ask the user to choose `Ollama` in the UI and then ignore the message. After 5 minutes, confirm: the selector is back on the active stack, `/api/stack/status` reports `pending: null`, and no `switch-stack.sh` process ran (`data/run/stack-switch.json` unchanged).

- [ ] **Step 6: A refused switch**

Start a reindex (`curl -s -X POST -H "Authorization: Bearer $T" localhost:3000/api/knowledge/reindex`), then request a switch from the UI. Expected: 409 with reason `reindex`, no Telegram message, selector reverts. Wait for the reindex to finish before continuing.

- [ ] **Step 7: Benchmark all three stacks**

```bash
npx tsx scripts/benchmark-stack.ts        # once per stack, switching between runs
npx tsx scripts/compare-benchmarks.ts
```

Record TTFT, tok/s and peak memory per stack, and update the README benchmark table.

- [ ] **Step 8: Record and commit**

Append a "Live verification" section to `docs/superpowers/plans/2026-09-18-omlx-stack-verification.md` with every step's output, including the `~/.omlx` cache size at the end and the memory pressure after a day on omlx. Then:

```bash
git add docs/superpowers/plans/2026-09-18-omlx-stack-verification.md README.md
git commit -m "docs: record the omlx stack live verification

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

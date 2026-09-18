import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const { ollama, mlx, omlx } = buildStacks({});

  it("uses the same model names", () => {
    expect(shellVar("OLLAMA_CHAT_MODEL")).toBe(ollama.chatModel);
    expect(shellVar("OLLAMA_EMBED_MODEL")).toBe(ollama.embeddingModel);
    expect(shellVar("MLX_CHAT_MODEL")).toBe(mlx.chatModel);
    expect(shellVar("MLX_EMBED_MODEL")).toBe(mlx.embeddingModel);
  });

  it("uses the same model names for omlx (warm_up must not hardcode ids that can drift)", () => {
    expect(shellVar("OMLX_CHAT_MODEL")).toBe(omlx.chatModel);
    expect(shellVar("OMLX_EMBED_MODEL")).toBe(omlx.embeddingModel);
    expect(script).toContain('chat_model="$OMLX_CHAT_MODEL"');
    expect(script).toContain('embed_model="$OMLX_EMBED_MODEL"');
  });

  it("uses the same ports", () => {
    expect(ollama.chatBaseUrl).toBe(`http://localhost:${shellVar("OLLAMA_PORT")}`);
    expect(mlx.chatBaseUrl).toBe(`http://localhost:${shellVar("MLX_CHAT_PORT")}`);
    expect(mlx.embedBaseUrl).toBe(`http://localhost:${shellVar("MLX_EMBED_PORT")}`);
    expect(omlx.chatBaseUrl).toBe(`http://localhost:${shellVar("OMLX_PORT")}`);
  });

  it("builds qwen3.8-pharma from the pulled base model with a 64k context", () => {
    expect(modelfile).toContain(`FROM ${shellVar("OLLAMA_BASE_MODEL")}`);
    expect(modelfile).toContain("PARAMETER num_ctx 65536");
  });

  it("warms up with the same thinking switch the client sends", () => {
    expect(script).toContain(`'"reasoning_effort":"none"'`);
    expect(script).toContain(`'"chat_template_kwargs":{"enable_thinking":false}'`);
    expect(JSON.stringify(ollama.chatExtraBody)).toBe('{"reasoning_effort":"none"}');
    expect(JSON.stringify(mlx.chatExtraBody)).toBe('{"chat_template_kwargs":{"enable_thinking":false}}');
  });
});

describe("switch-stack.sh long-context settings", () => {
  it("caps the MLX prompt cache with an overridable byte limit", () => {
    expect(script).toContain('MLX_PROMPT_CACHE_BYTES="${MLX_PROMPT_CACHE_BYTES:-8589934592}"');
    expect(script).toContain('--prompt-cache-bytes "$MLX_PROMPT_CACHE_BYTES"');
    expect(script).toContain("start_ollama && ensure_ollama_ctx");
  });
});

describe("switch-stack.sh ollama-ctx", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Runs the command with a stub `ollama` first on a PATH that cannot reach the real one
  function runWithStubOllama(currentCtx: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ollama-ctx-"));
    dirs.push(dir);
    const log = join(dir, "ollama.log");
    const stub = join(dir, "ollama");
    writeFileSync(
      stub,
      [
        "#!/bin/bash",
        'echo "$*" >> "$STUB_LOG"',
        'if [ "$1" = "show" ]; then',
        "  printf 'min_p                          0\\nnum_ctx                        %s\\ntemperature                    1\\n' \"$STUB_CTX\"",
        "fi",
      ].join("\n")
    );
    chmodSync(stub, 0o755);
    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "ollama-ctx"], {
      encoding: "utf-8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        STUB_LOG: log,
        STUB_CTX: currentCtx,
      },
    });
    expect(result.status).toBe(0);
    return readFileSync(log, "utf-8");
  }

  it("recreates qwen3.8-pharma when its context differs from the Modelfile", () => {
    const calls = runWithStubOllama("16384");
    expect(calls).toContain("show qwen3.8-pharma --parameters");
    expect(calls).toContain(`create qwen3.8-pharma -f ${join(process.cwd(), "ollama", "qwen3.8-pharma.Modelfile")}`);
  });

  it("leaves qwen3.8-pharma alone when the context already matches", () => {
    const calls = runWithStubOllama("65536");
    expect(calls).toContain("show qwen3.8-pharma --parameters");
    expect(calls).not.toContain("create");
  });
});

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

  it("bounds the oMLX SSD cache with an overridable size", () => {
    expect(script).toContain('OMLX_CACHE_MAX_GB="${OMLX_CACHE_MAX_GB:-20}"');
    expect(script).toContain('--paged-ssd-cache-max-size "${OMLX_CACHE_MAX_GB}GB"');
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

  it("prepares by stopping every other stack, not just MLX", () => {
    // Previously: a bare `stop_mlx` before the Ollama pulls, so an active omlx server kept
    // serving a 27B model on :8090 throughout `prepare` (breaking "exactly one active stack").
    expect(script).toContain("stop_other_stacks ollama\n  start_ollama");
    expect(script).not.toContain("\n  stop_mlx\n  start_ollama");
  });

  it("shows the omlx log when a switch to omlx fails", () => {
    expect(script).toContain(
      'for file in "$LOG_DIR/mlx-chat.log" "$LOG_DIR/mlx-embed.log" "$LOG_DIR/omlx.log" "$LOG_DIR/app.log"; do'
    );
  });
});

describe("switch-stack.sh stop_other_stacks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Sources only the function definitions (everything before the CLI dispatch at the bottom of the
  // file), then overrides stop_ollama/stop_mlx/stop_omlx with stubs before calling stop_other_stacks,
  // so no real port/process/service logic ever runs. SCRIPT_DIR/PROJECT_DIR are supplied via env
  // instead of being recomputed from $0, since sourcing a copy would otherwise get $0 wrong.
  it("keeps stopping the remaining stacks after one stop fails, and aggregates the failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "stop-other-stacks-"));
    dirs.push(dir);
    const log = join(dir, "calls.log");

    const dispatchIndex = script.split("\n").findIndex((line) => line.startsWith('case "${1:-}" in'));
    const funcs = script
      .split("\n")
      .slice(0, dispatchIndex)
      .filter((line) => !line.startsWith('SCRIPT_DIR="') && !line.startsWith('PROJECT_DIR="'))
      .join("\n");
    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, funcs);

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "",
      "# Stubs: replace the real stop_* implementations so no port/process/service logic runs.",
      'stop_ollama() { echo "stop_ollama" >>"$STUB_LOG"; return 1; }',
      'stop_mlx() { echo "stop_mlx" >>"$STUB_LOG"; return 0; }',
      'stop_omlx() { echo "stop_omlx" >>"$STUB_LOG"; return 0; }',
      "",
      "# funcs.sh carries `set -euo pipefail`; capture the return code via || so a nonzero",
      "# result doesn't make the whole harness exit before it's recorded.",
      "rc=0",
      "stop_other_stacks omlx || rc=$?",
      'echo "rc=$rc" >>"$STUB_LOG"',
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        STUB_LOG: log,
      },
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf-8");
    // ollama's stop fails, but the loop must still reach mlx (the bug this replaces would not,
    // if a duplicated case body were mis-ordered) — and must never touch the target, omlx.
    expect(calls).toContain("stop_ollama");
    expect(calls).toContain("stop_mlx");
    expect(calls).not.toContain("stop_omlx");
    expect(calls).toContain("rc=1");
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
    // Amended: a localhost default is useless for the iPad-over-Tailscale confirmation link,
    // so start_app reads the stored public URL (with a hostname-based fallback) instead of
    // defaulting PHARMALLM_PUBLIC_URL to http://localhost:$APP_PORT.
    expect(script).toContain('PHARMALLM_PUBLIC_URL="$(public_url)"');
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

  it("also stores the public URL file when PHARMALLM_PUBLIC_URL is set, at mode 600, printing no value", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-url-"));
    dirs.push(dir);

    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "telegram"], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        TELEGRAM_BOT_TOKEN: "123456:AA-secret",
        TELEGRAM_CHAT_ID: "424242",
        PHARMALLM_PUBLIC_URL: "https://mac-mini.example.ts.net:3443",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "run", "telegram-bot-token"), "utf-8").trim()).toBe("123456:AA-secret");
    expect(readFileSync(join(dir, "run", "telegram-chat-id"), "utf-8").trim()).toBe("424242");
    expect(readFileSync(join(dir, "run", "public-url"), "utf-8").trim()).toBe("https://mac-mini.example.ts.net:3443");
    expect(statSync(join(dir, "run", "telegram-bot-token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "run", "telegram-chat-id")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "run", "public-url")).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain("123456:AA-secret");
    expect(result.stdout + result.stderr).not.toContain("https://mac-mini.example.ts.net:3443");
  });
});

describe("switch-stack.sh public_url", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Sources only the function definitions (as in the stop_other_stacks harness above), then calls
  // public_url() directly with no data/run/public-url file present.
  it("falls back to the hostname form when the file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-url-"));
    dirs.push(dir);

    const dispatchIndex = script.split("\n").findIndex((line) => line.startsWith('case "${1:-}" in'));
    const funcs = script
      .split("\n")
      .slice(0, dispatchIndex)
      .filter((line) => !line.startsWith('SCRIPT_DIR="') && !line.startsWith('PROJECT_DIR="'))
      .join("\n");
    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, funcs);

    const outFile = join(dir, "out.txt");
    const harness = ["#!/bin/bash", "set -uo pipefail", 'source "$FUNCS_FILE"', 'public_url >"$OUT_FILE"'].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        OUT_FILE: outFile,
      },
    });

    expect(result.status).toBe(0);
    const hostname = spawnSync("hostname", ["-s"], { encoding: "utf-8" }).stdout.trim();
    expect(readFileSync(outFile, "utf-8").trim()).toBe(`https://${hostname}.local:3443`);
  });
});

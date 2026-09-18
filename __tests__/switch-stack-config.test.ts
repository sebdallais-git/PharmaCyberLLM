import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

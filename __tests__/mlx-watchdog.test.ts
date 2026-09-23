import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStacks } from "../src/config/llm-stacks.js";

const scriptsDir = join(process.cwd(), "scripts");
const switchStack = readFileSync(join(scriptsDir, "switch-stack.sh"), "utf-8");

function shellVar(name: string): string {
  const match = switchStack.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${name} not found in switch-stack.sh`);
  return match[1];
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("switch-stack.sh chat-endpoint", () => {
  // Read-only: prints where a stack serves chat, so the watchdog probes the same
  // server the stack actually runs instead of a port it assumes.
  function chatEndpoint(stack: string) {
    return spawnSync("bash", [join(scriptsDir, "switch-stack.sh"), "chat-endpoint", stack], {
      encoding: "utf-8",
      env: { ...process.env, PHARMALLM_RUN_DIR: tempDir() },
    });
  }

  it("prints the port and model each stack serves chat on", () => {
    expect(chatEndpoint("mlx").stdout.trim()).toBe(
      `http://localhost:${shellVar("MLX_CHAT_PORT")} ${shellVar("MLX_CHAT_MODEL")}`,
    );
    expect(chatEndpoint("omlx").stdout.trim()).toBe(
      `http://localhost:${shellVar("OMLX_PORT")} ${shellVar("OMLX_CHAT_MODEL")}`,
    );
    const { splash } = buildStacks({});
    expect(chatEndpoint("splash").stdout.trim()).toBe(`${splash.chatBaseUrl} ${splash.chatModel}`);
    expect(chatEndpoint("ollama").stdout.trim()).toBe(
      `http://localhost:${shellVar("OLLAMA_PORT")} ${shellVar("OLLAMA_CHAT_MODEL")}`,
    );
  });

  it("rejects an unknown stack", () => {
    const result = chatEndpoint("nonsense");
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("mlx-watchdog.sh", () => {
  // Runs a copy of the watchdog in a sandbox whose switch-stack.sh, curl, lsof,
  // kill and pgrep are recorders: no real port is probed, no process is killed
  // and no stack is started, even on the restart path.
  function runWatchdog(opts: { stack: string; httpCode: string; priorStrikes?: number }) {
    const root = tempDir();
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const run = join(root, "run");
    const calls = join(root, "calls.log");
    for (const dir of [scripts, bin, run]) mkdirSync(dir);
    copyFileSync(join(scriptsDir, "mlx-watchdog.sh"), join(scripts, "mlx-watchdog.sh"));
    writeFileSync(join(run, "active-stack"), `${opts.stack}\n`);
    if (opts.priorStrikes) writeFileSync(join(run, "mlx-watchdog.strikes"), `${opts.priorStrikes}\n`);

    const stub = (path: string, body: string) => {
      writeFileSync(path, `#!/bin/bash\n${body}\n`);
      chmodSync(path, 0o755);
    };
    stub(
      join(scripts, "switch-stack.sh"),
      `echo "switch-stack $*" >>"${calls}"
case "$1 $2" in
  "chat-endpoint mlx") echo "http://localhost:8080 mlx-chat-model" ;;
  "chat-endpoint omlx") echo "http://localhost:8090 omlx-chat-model" ;;
  "chat-endpoint ollama") echo "http://localhost:11434 ollama-chat-model" ;;
  chat-endpoint*) exit 1 ;;
esac`,
    );
    stub(join(bin, "curl"), `echo "curl $*" >>"${calls}"; printf '%s' "${opts.httpCode}"`);
    stub(join(bin, "lsof"), `echo "lsof $*" >>"${calls}"; exit 1`);
    stub(join(bin, "kill"), `echo "kill $*" >>"${calls}"`);
    stub(join(bin, "pgrep"), "exit 1");

    const result = spawnSync("bash", [join(scripts, "mlx-watchdog.sh")], {
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PHARMALLM_RUN_DIR: run },
    });
    const log = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
    return { result, calls: log.split("\n").filter(Boolean) };
  }

  it("probes the omlx server where switch-stack says it serves chat, with its model", () => {
    const { result, calls } = runWatchdog({ stack: "omlx", httpCode: "200" });
    expect(result.status).toBe(0);
    const probe = calls.find((c) => c.startsWith("curl "));
    expect(probe).toContain("http://localhost:8090/v1/chat/completions");
    expect(probe).toContain('"model":"omlx-chat-model"');
  });

  it("still probes mlx on its own port", () => {
    const { calls } = runWatchdog({ stack: "mlx", httpCode: "200" });
    const probe = calls.find((c) => c.startsWith("curl "));
    expect(probe).toContain("http://localhost:8080/v1/chat/completions");
    expect(probe).toContain('"model":"mlx-chat-model"');
  });

  it("leaves ollama alone", () => {
    const { result, calls } = runWatchdog({ stack: "ollama", httpCode: "500", priorStrikes: 1 });
    expect(result.status).toBe(0);
    expect(calls).toEqual([]);
  });

  it("restarts the omlx server on its own port, not mlx's", () => {
    const { calls } = runWatchdog({ stack: "omlx", httpCode: "500", priorStrikes: 1 });
    const lsofPorts = calls.filter((c) => c.startsWith("lsof ")).map((c) => c.match(/:(\d+)/)?.[1]);
    expect(lsofPorts.length).toBeGreaterThan(0);
    expect(new Set(lsofPorts)).toEqual(new Set(["8090"]));
    expect(calls).toContain("switch-stack ensure-stack omlx");
  });

  it("does nothing when switch-stack cannot say where the stack serves chat", () => {
    const { result, calls } = runWatchdog({ stack: "unknown", httpCode: "500", priorStrikes: 1 });
    expect(result.status).toBe(0);
    expect(calls.some((c) => c.startsWith("curl ") || c.startsWith("lsof ") || c.includes("ensure-stack"))).toBe(false);
  });
});

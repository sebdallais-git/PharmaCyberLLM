// Benchmark the active stack end to end through the running PharmaLLM app
// Usage: npx tsx scripts/benchmark-stack.ts [--runs 3] [--app http://localhost:3000] [--questions bench/questions.json]

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSseLines } from "../src/services/llm-client.js";
import type { ChatTimings } from "../src/services/bench-mode.js";
import type { BenchEnvironment, BenchQuestion, BenchmarkFile, MemoryPeak, QuestionResult, RunResult } from "./lib/benchmark-types.js";

interface Options {
  runs: number;
  appUrl: string;
  questionsPath: string;
}

interface ChatEvent {
  token?: string;
  error?: string;
  done?: boolean;
  stack?: string;
  timings?: ChatTimings;
  chunkIds?: string[];
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    runs: Number(value("--runs") ?? 3),
    appUrl: value("--app") ?? "http://localhost:3000",
    questionsPath: value("--questions") ?? join(process.cwd(), "bench", "questions.json"),
  };
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

// Stack processes: Ollama loads models in "ollama runner" children; MLX runs two Python servers
function stackPatterns(stack: string): string[] {
  return stack === "mlx" ? ["mlx_lm.server", "mlx-embed-server.py"] : ["ollama serve", "ollama runner"];
}

function sampleMemory(stack: string): MemoryPeak {
  let processKb = 0;
  for (const pattern of stackPatterns(stack)) {
    const pids = run("pgrep", ["-f", pattern]).split("\n").filter((pid) => /^\d+$/.test(pid));
    for (const pid of pids) {
      processKb += Number(run("ps", ["-o", "rss=", "-p", pid])) || 0;
    }
  }

  const vm = run("vm_stat", []);
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label: string): number => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const usedPages = pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");

  return {
    processMb: Math.round(processKb / 1024),
    systemUsedMb: Math.round((usedPages * pageSize) / (1024 * 1024)),
  };
}

async function getJson<T>(url: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const resp = await fetch(url, { method });
  if (!resp.ok) throw new Error(`${method} ${url} failed (${resp.status})`);
  return (await resp.json()) as T;
}

async function ask(appUrl: string, question: string, runNumber: number): Promise<RunResult> {
  let answer = "";
  try {
    const resp = await fetch(`${appUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, benchmark: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) {
      return { run: runNumber, answer: "", timings: null, chunkIds: [], error: `HTTP ${resp.status}` };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseLines(buffer);
      buffer = parsed.rest;

      for (const data of parsed.events) {
        const event = JSON.parse(data) as ChatEvent;
        if (event.error) {
          return { run: runNumber, answer, timings: null, chunkIds: [], error: event.error };
        }
        if (event.token) answer += event.token;
        if (event.done) {
          return { run: runNumber, answer, timings: event.timings ?? null, chunkIds: event.chunkIds ?? [] };
        }
      }
    }

    return { run: runNumber, answer, timings: null, chunkIds: [], error: "stream ended without a done event" };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const message = isTimeout ? "request timed out after 600 s" : err instanceof Error ? err.message : String(err);
    return { run: runNumber, answer, timings: null, chunkIds: [], error: message };
  }
}

async function waitForIdle(appUrl: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (true) {
    const status = await getJson<{ runningJobs: string[] }>(`${appUrl}/api/bench/status`);
    if (status.runningJobs.length === 0) return;
    if (Date.now() > deadline) throw new Error(`Background jobs still running: ${status.runningJobs.join(", ")}`);
    console.log(`Waiting for background jobs to finish: ${status.runningJobs.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const questions = JSON.parse(await readFile(options.questionsPath, "utf-8")) as BenchQuestion[];

  const health = await getJson<{ status: string; stack: string }>(`${options.appUrl}/api/health`);
  if (health.status === "unhealthy") throw new Error(`PharmaLLM is unhealthy on the ${health.stack} stack`);
  const models = await getJson<{ chatModel: string; embeddingModel: string }>(`${options.appUrl}/api/chat/models`);
  const stack = health.stack;

  const environment: BenchEnvironment = {
    macos: run("sw_vers", ["-productVersion"]),
    chip: run("sysctl", ["-n", "machdep.cpu.brand_string"]),
    thermal: run("pmset", ["-g", "therm"]),
    stackVersion: stack === "mlx"
      ? run(join(process.cwd(), "python", "mlx-venv", "bin", "python"), [
          "-c",
          "import importlib.metadata as m; print('mlx', m.version('mlx'), 'mlx-lm', m.version('mlx-lm'))",
        ])
      : run("ollama", ["--version"]),
    chatModel: models.chatModel,
    embeddingModel: models.embeddingModel,
  };

  await getJson(`${options.appUrl}/api/bench/start`, "POST");
  const memoryPeak: MemoryPeak = { processMb: 0, systemUsedMb: 0 };
  const sampler = setInterval(() => {
    const sample = sampleMemory(stack);
    memoryPeak.processMb = Math.max(memoryPeak.processMb, sample.processMb);
    memoryPeak.systemUsedMb = Math.max(memoryPeak.systemUsedMb, sample.systemUsedMb);
  }, 1000);

  const startedAt = new Date().toISOString();
  const results: QuestionResult[] = [];

  try {
    await waitForIdle(options.appUrl);

    console.log(`Benchmarking ${stack}: ${questions.length} questions × ${options.runs} runs (plus one warm-up)`);
    await ask(options.appUrl, questions[0].question, 0); // warm-up, discarded

    for (const question of questions) {
      const runs: RunResult[] = [];
      for (let n = 1; n <= options.runs; n++) {
        const result = await ask(options.appUrl, question.question, n);
        runs.push(result);
        const summary = result.error
          ? `error: ${result.error}`
          : `TTFT ${result.timings?.ttftMs ?? 0} ms, ${(result.timings?.decodeTokPerSec ?? 0).toFixed(1)} tok/s`;
        console.log(`  ${question.id} run ${n}: ${summary}`);
      }
      results.push({ ...question, runs });
    }
  } finally {
    clearInterval(sampler);
    await getJson(`${options.appUrl}/api/bench/stop`, "POST").catch(() => undefined);
  }

  const output: BenchmarkFile = {
    stack,
    startedAt,
    finishedAt: new Date().toISOString(),
    runsPerQuestion: options.runs,
    environment,
    memoryPeak,
    questions: results,
  };

  const dir = join(process.cwd(), "data", "benchmarks");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stack}-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Saved ${path}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

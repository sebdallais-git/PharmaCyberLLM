// Types shared by the benchmark runner and the comparison report

import type { ChatTimings } from "../../src/services/bench-mode.js";

export interface BenchQuestion {
  id: string;
  category: string;
  question: string;
}

export interface RunResult {
  run: number;
  answer: string;
  timings: ChatTimings | null;
  chunkIds: string[];
  error?: string;
}

export interface QuestionResult extends BenchQuestion {
  runs: RunResult[];
}

export interface BenchEnvironment {
  macos: string;
  chip: string;
  thermal: string;
  stackVersion: string;
  chatModel: string;
  embeddingModel: string;
}

export interface MemoryPeak {
  processMb: number;
  systemUsedMb: number;
}

export interface BenchmarkFile {
  stack: string;
  startedAt: string;
  finishedAt: string;
  runsPerQuestion: number;
  environment: BenchEnvironment;
  memoryPeak: MemoryPeak;
  questions: QuestionResult[];
}

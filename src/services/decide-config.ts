// System One decision config: the verdict vocabulary and the thresholds that
// map a scorer probability onto it.
//
// Thresholds are config rather than constants because they are judgement, not
// statistics: open-jev's noul is a softmax over log-probs, not a calibrated
// confidence, so the numbers are expected to move once the replay harness
// reports how they actually distribute.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlDocument } from "yaml";

export const VERDICTS = ["resolved", "review", "unresolved"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export interface DecideThresholds {
  resolved: number;
  unresolved: number;
}

export interface DecideConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  thresholds: DecideThresholds;
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`decide config: "${key}" must be a non-empty string`);
  }
  return value;
}

function requireProbability(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`decide config: threshold "${key}" must be a number between 0 and 1`);
  }
  return value;
}

export function parseDecideConfig(raw: unknown): DecideConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("decide config: expected a YAML mapping");
  }
  const doc = raw as Record<string, unknown>;
  const thresholdsRaw = doc.thresholds;
  if (typeof thresholdsRaw !== "object" || thresholdsRaw === null) {
    throw new Error("decide config: thresholds must be a mapping");
  }
  const t = thresholdsRaw as Record<string, unknown>;
  const resolved = requireProbability(t, "resolved");
  const unresolved = requireProbability(t, "unresolved");
  // Strictly greater: equal thresholds collapse the review band to nothing,
  // and inverted ones invert every verdict.
  if (!(resolved > unresolved)) {
    throw new Error(
      `decide config: threshold "resolved" (${resolved}) must be strictly greater than "unresolved" (${unresolved})`,
    );
  }

  const timeout = doc.timeout_ms;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`decide config: "timeout_ms" must be a positive number`);
  }

  return {
    baseUrl: requireString(doc, "base_url"),
    model: requireString(doc, "model"),
    timeoutMs: timeout,
    thresholds: { resolved, unresolved },
  };
}

export function loadDecideConfig(path: string = resolve(process.cwd(), "config", "decide.yaml")): DecideConfig {
  return parseDecideConfig(parseYamlDocument(readFileSync(path, "utf8")));
}

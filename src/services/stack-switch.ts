// Pending stack switches: a UI request becomes a one-time token, confirmed out of band through Telegram.
// Pure state plus pure parsing; the HTTP layer owns I/O and process spawning.

import { isStackName } from "../config/llm-stacks.js";
import type { StackName } from "../config/llm-stacks.js";

export const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
// A switch takes two to three minutes; 15 gives generous headroom while still letting a killed
// script's stale "in progress" state age out, instead of locking switching out forever.
export const SWITCHING_WINDOW_MS = 15 * 60 * 1000;

const PHASES = ["confirmed", "stopping", "starting", "warming", "indexing", "ready", "failed"] as const;
export type SwitchPhase = (typeof PHASES)[number];

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

export type SwitchRefusalReason = "already_active" | "pending" | "benchmark" | "reindex" | "switching";

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
  // The state machine stays pure: the HTTP layer injects the progress read (same file
  // GET /api/stack/status reads), so request() can see a switch that is actively running even
  // after `pending` has already been cleared by the Telegram confirmation.
  currentProgress(): SwitchProgress | null;
}

export interface StackSwitch {
  request(target: StackName): SwitchOutcome;
  confirm(token: string): PendingSwitch | null;
  pending(): PendingSwitch | null;
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
      const progress = deps.currentProgress();
      if (
        progress &&
        progress.phase !== "ready" &&
        progress.phase !== "failed" &&
        deps.now() - progress.startedAt < SWITCHING_WINDOW_MS
      ) {
        return { ok: false, reason: "switching", message: "a switch is already in progress" };
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

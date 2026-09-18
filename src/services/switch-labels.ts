// One sentence describing where a stack switch has got to, shared by the UI and its tests.
// public/app.js keeps a literal second copy (the browser cannot import TypeScript and public/
// is served with no bundler); __tests__/switch-labels.test.ts pins the two copies together.

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

// Formats the time left to confirm a pending switch as m:ss, floored at 0:00 once it has expired.
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

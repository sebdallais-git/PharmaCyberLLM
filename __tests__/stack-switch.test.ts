import { describe, expect, it } from "@jest/globals";
import { CONFIRM_WINDOW_MS, SWITCHING_WINDOW_MS, createStackSwitch, parseProgress } from "../src/services/stack-switch.js";
import type { StackSwitchDeps, SwitchProgress } from "../src/services/stack-switch.js";

interface Harness {
  clock: { value: number };
  switcher: ReturnType<typeof createStackSwitch>;
  state: {
    active: "ollama" | "mlx" | "omlx";
    benchmark: boolean;
    jobs: string[];
    progress: SwitchProgress | null;
  };
}

function harness(): Harness {
  const clock = { value: 1_000 };
  const state = { active: "ollama" as const, benchmark: false, jobs: [] as string[], progress: null as SwitchProgress | null };
  let counter = 0;
  const deps: StackSwitchDeps = {
    now: () => clock.value,
    newId: () => `id-${++counter}`,
    newToken: () => `token-${counter}`,
    activeStack: () => state.active,
    isBenchmarkActive: () => state.benchmark,
    runningJobs: () => state.jobs,
    currentProgress: () => state.progress,
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

  // F1: request() only ever refused a second UI-issued token (the `pending` reason). Once the
  // Telegram link is tapped, `pending` clears immediately and activeStack() keeps reporting the
  // PREVIOUS stack until the switch finishes, so a second POST for a third stack was accepted and
  // a second switch-stack.sh ran concurrently against the same processes.
  it("refuses while a previous switch is actively running (non-terminal phase, started recently)", () => {
    const h = harness();
    h.state.progress = { phase: "warming", target: "mlx", previous: "ollama", startedAt: h.clock.value - 60_000 };

    const outcome = h.switcher.request("omlx");

    expect(outcome).toEqual({ ok: false, reason: "switching", message: "a switch is already in progress" });
  });

  it("does not refuse once the running switch reached ready", () => {
    const h = harness();
    h.state.progress = { phase: "ready", target: "mlx", previous: "ollama", startedAt: h.clock.value - 60_000, finishedAt: h.clock.value };
    h.state.active = "mlx";

    expect(h.switcher.request("omlx").ok).toBe(true);
  });

  it("does not refuse once the running switch reached failed", () => {
    const h = harness();
    h.state.progress = { phase: "failed", target: "mlx", previous: "ollama", startedAt: h.clock.value - 60_000, finishedAt: h.clock.value, error: "boom" };

    expect(h.switcher.request("omlx").ok).toBe(true);
  });

  // F2: ensure_index legitimately rebuilds on an ollama<->mlx switch with a stale index, and a
  // rebuild re-embeds the whole knowledge base in 12-16 minutes. At the old 15-minute bound the
  // guard lapsed mid-rebuild and a second switch-stack.sh was accepted against the same processes.
  it("still refuses 20 minutes in, while a legitimate index rebuild is running", () => {
    const h = harness();
    h.state.progress = { phase: "indexing", target: "mlx", previous: "ollama", startedAt: h.clock.value - 20 * 60 * 1000 };

    expect(h.switcher.request("omlx")).toEqual({ ok: false, reason: "switching", message: "a switch is already in progress" });
  });

  it("bounds the refusal at 30 minutes", () => {
    expect(SWITCHING_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("does not refuse a non-terminal phase older than the window (a killed script must not lock switching out forever)", () => {
    const h = harness();
    h.state.progress = { phase: "warming", target: "mlx", previous: "ollama", startedAt: h.clock.value - (SWITCHING_WINDOW_MS + 1) };

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

describe("cancel", () => {
  it("clears the pending switch without starting it and remembers which request was cancelled", () => {
    const h = harness();
    const outcome = h.switcher.request("omlx");
    if (!outcome.ok) throw new Error("request refused");

    const cancelled = h.switcher.cancel(outcome.pending.token);

    expect(cancelled?.target).toBe("omlx");
    expect(h.switcher.pending()).toBeNull();
    expect(h.switcher.lastCancelled()).toEqual({ id: outcome.pending.id, target: "omlx" });
    expect(h.switcher.confirm(outcome.pending.token)).toBeNull();
  });

  it("ignores a wrong token and leaves the pending switch alone", () => {
    const h = harness();
    h.switcher.request("omlx");

    expect(h.switcher.cancel("nope")).toBeNull();
    expect(h.switcher.pending()?.target).toBe("omlx");
    expect(h.switcher.lastCancelled()).toBeNull();
  });

  it("refuses an expired token", () => {
    const h = harness();
    const outcome = h.switcher.request("omlx");
    if (!outcome.ok) throw new Error("request refused");
    h.clock.value += CONFIRM_WINDOW_MS;

    expect(h.switcher.cancel(outcome.pending.token)).toBeNull();
  });

  it("forgets the last cancel once a new switch is requested", () => {
    const h = harness();
    const first = h.switcher.request("omlx");
    if (!first.ok) throw new Error("request refused");
    h.switcher.cancel(first.pending.token);

    h.switcher.request("mlx");

    expect(h.switcher.lastCancelled()).toBeNull();
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

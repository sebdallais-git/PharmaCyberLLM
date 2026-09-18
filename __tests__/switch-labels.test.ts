import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { describeSwitch, formatCountdown } from "../src/services/switch-labels.js";
import type { SwitchStatus } from "../src/services/switch-labels.js";

// The exact status objects exercised by the tests below, reused by the browser-copy drift test.
const cases: SwitchStatus[] = [
  { active: "mlx", pending: null, progress: null },
  { active: "ollama", pending: { target: "omlx", expires_at: 0 }, progress: null },
  { active: "ollama", pending: null, progress: { phase: "stopping", target: "omlx", previous: "ollama", startedAt: 0 } },
  { active: "ollama", pending: null, progress: { phase: "warming", target: "omlx", previous: "ollama", startedAt: 0 } },
  { active: "ollama", pending: null, progress: { phase: "indexing", target: "omlx", previous: "ollama", startedAt: 0 } },
  {
    active: "omlx",
    pending: null,
    progress: { phase: "ready", target: "omlx", previous: "ollama", startedAt: 1_000, finishedAt: 97_000 },
  },
  {
    active: "ollama",
    pending: null,
    progress: { phase: "failed", target: "omlx", previous: "ollama", startedAt: 0, error: "omlx did not come up" },
  },
];

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

  // Amendment B: the browser cannot import TypeScript, so public/app.js keeps a second, literal
  // copy of this wording (describeStackStatus). This test fails if either copy changes a word.
  it("keeps the browser copy of the wording identical to the module", () => {
    const describeStackStatus = loadBrowserFunction("describeStackStatus") as (status: unknown) => string;
    for (const status of cases) {
      expect(describeStackStatus(status)).toBe(describeSwitch(status));
    }
  });
});

describe("formatCountdown", () => {
  it("formats remaining milliseconds as m:ss, floored to the second", () => {
    expect(formatCountdown(277_000)).toBe("4:37");
    expect(formatCountdown(65_000)).toBe("1:05");
  });

  it("floors a negative remainder at 0:00", () => {
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  // Amendment C: the browser keeps a literal copy of this helper too, guarded the same way as B.
  it("keeps the browser copy of the countdown formatter identical to the module", () => {
    const browserFormatCountdown = loadBrowserFunction("formatCountdown") as (msRemaining: number) => string;
    for (const ms of [277_000, 65_000, -5_000, 0, 599_000]) {
      expect(browserFormatCountdown(ms)).toBe(formatCountdown(ms));
    }
  });
});

// Extracts one top-level function's source out of public/app.js and evaluates it in isolation, so
// the drift tests above never load or execute the rest of the browser script (which touches the
// DOM and fetch, neither available under Jest's node test environment).
function loadBrowserFunction(name: string): (...args: unknown[]) => unknown {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end + 2);
  return new Function(`${body}; return ${name};`)() as (...args: unknown[]) => unknown;
}

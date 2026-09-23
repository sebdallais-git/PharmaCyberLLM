import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(process.cwd(), "scripts", "mlx-watchdog.sh"), "utf8");

describe("mlx watchdog", () => {
  // The watchdog probes a hardcoded port. Whatever stacks its gate admits, it
  // must actually be able to watch them -- a gate that admits a stack it then
  // probes on the wrong port reports health for a server it never contacted.
  it("only admits stacks it can actually probe", () => {
    const gate = script.match(/case "\$stack" in\s*([^)]*)\)/)?.[1] ?? "";
    const admitted = gate.split("|").map((s) => s.trim()).filter(Boolean);
    const portsProbed = [...script.matchAll(/localhost:(\d+)/g)].map((m) => m[1]);

    // Either the script is parameterised by stack, or it admits exactly one.
    const parameterised = /\$\{?(MLX_CHAT_PORT|WATCH_PORT|PORT)\b/.test(script);
    expect(parameterised || admitted.length === 1).toBe(true);
    expect(new Set(portsProbed).size).toBeLessThanOrEqual(parameterised ? 99 : 1);
  });
});

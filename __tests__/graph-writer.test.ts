import { describe, expect, it } from "@jest/globals";
import { writeGraphFacts, type GraphWriter } from "../src/services/graph-writer.js";
import type { GraphFacts } from "../src/services/graph-schema.js";

function fakeWriter(): GraphWriter & { merged: string[]; cleared: number } {
  const merged: string[] = [];
  return {
    merged,
    cleared: 0,
    async clear() {
      this.cleared++;
    },
    async mergeNode(label, id) {
      merged.push(`node ${label}:${id}`);
    },
    async mergeRelationship(type, from, to, properties, identity) {
      const key = (identity ?? []).map((k) => `${k}=${properties[k]}`).join(",");
      merged.push(`rel ${from}-[${type}${key ? " " + key : ""}]->${to}`);
    },
  };
}

const facts = (overrides: Partial<GraphFacts> = {}): GraphFacts => ({
  nodes: [
    { label: "Vendor", id: "dell", properties: {} },
    { label: "Segment", id: "storage-block", properties: {} },
    { label: "Product", id: "PowerStore", properties: {} },
  ],
  relationships: [
    { type: "OFFERS", from: "dell", to: "PowerStore", properties: {} },
    { type: "IN_SEGMENT", from: "PowerStore", to: "storage-block", properties: {} },
  ],
  ...overrides,
});

describe("writeGraphFacts", () => {
  it("writes each node once even when several briefs assert it", async () => {
    // dell and its segment recur across every Dell brief; the graph must hold
    // one node, not one per file.
    const writer = fakeWriter();
    const a = facts();
    const b = facts({
      nodes: [
        { label: "Vendor", id: "dell", properties: {} },
        { label: "Segment", id: "storage-file", properties: {} },
      ],
      relationships: [],
    });

    await writeGraphFacts([a, b], writer);

    expect(writer.merged.filter((m) => m === "node Vendor:dell")).toHaveLength(1);
    expect(writer.merged.filter((m) => m.startsWith("node Segment:"))).toHaveLength(2);
  });

  it("refuses a relationship whose endpoint has no node", async () => {
    // A dangling edge is how a graph silently grows nodes nobody researched.
    const writer = fakeWriter();
    const dangling = facts({
      relationships: [{ type: "COMPETES_IN", from: "dell", to: "hpe", properties: {} }],
    });

    await expect(writeGraphFacts([dangling], writer)).rejects.toThrow(/hpe/);
  });

  it("refuses a label outside the closed set even though parsing already checked", async () => {
    const writer = fakeWriter();
    const bad = facts({
      // @ts-expect-error deliberately outside the closed set
      nodes: [{ label: "ThreatActor", id: "Sandworm", properties: {} }],
      relationships: [],
    });

    await expect(writeGraphFacts([bad], writer)).rejects.toThrow(/ThreatActor/);
  });

  it("refuses a relationship type outside the closed set", async () => {
    const writer = fakeWriter();
    const bad = facts({
      // @ts-expect-error deliberately outside the closed set
      relationships: [{ type: "PERPETRATED", from: "dell", to: "PowerStore", properties: {} }],
    });

    await expect(writeGraphFacts([bad], writer)).rejects.toThrow(/PERPETRATED/);
  });

  it("clears the graph first only when asked to rebuild", async () => {
    const writer = fakeWriter();

    await writeGraphFacts([facts()], writer);
    expect(writer.cleared).toBe(0);

    await writeGraphFacts([facts()], writer, { rebuild: true });
    expect(writer.cleared).toBe(1);
  });

  it("produces the same writes when run twice", async () => {
    const first = fakeWriter();
    const second = fakeWriter();

    await writeGraphFacts([facts()], first);
    await writeGraphFacts([facts()], second);
    await writeGraphFacts([facts()], second);

    expect(second.merged).toEqual([...first.merged, ...first.merged]);
  });
});

describe("relationships distinguished by a property", () => {
  // An account can use one vendor in several segments: Roche runs HPE in both
  // compute-ai and compute-standard. Merging on (from, type, to) alone collapses
  // those into one edge and the second segment is lost silently -- which is
  // exactly what happened against real data on 2026-09-21.
  it("keeps one USES edge per segment between the same pair", async () => {
    const writer = fakeWriter();
    const facts = {
      nodes: [
        { label: "Account" as const, id: "roche", properties: {} },
        { label: "Vendor" as const, id: "hpe", properties: {} },
      ],
      relationships: [
        { type: "USES" as const, from: "roche", to: "hpe", properties: { segment: "compute-ai" } },
        { type: "USES" as const, from: "roche", to: "hpe", properties: { segment: "compute-standard" } },
      ],
    };

    await writeGraphFacts([facts], writer);

    const uses = writer.merged.filter((m) => m.includes("[USES"));
    expect(uses).toHaveLength(2);
    expect(new Set(uses).size).toBe(2);
  });
});

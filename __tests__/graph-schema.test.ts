import { describe, expect, it } from "@jest/globals";
import { parseVendorBrief, briefToGraphFacts } from "../src/services/graph-schema.js";

const brief = (overrides: Record<string, string> = {}) => {
  const fm: Record<string, string> = {
    vendor: "dell",
    segment: "storage-block",
    position: "leader",
    confidence: "high",
    as_of: "2026-09-21",
    products: "[PowerStore, PowerMax]",
    competitors: "[hpe, netapp]",
    rationale: "Broadest portfolio.",
    ...overrides,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n## Portfolio\n\nBody text.\n`;
};

describe("parseVendorBrief", () => {
  it("reads the frontmatter and keeps the body separate", () => {
    const parsed = parseVendorBrief(brief());

    expect(parsed.vendor).toBe("dell");
    expect(parsed.segment).toBe("storage-block");
    expect(parsed.products).toEqual(["PowerStore", "PowerMax"]);
    expect(parsed.body).toContain("Body text.");
    expect(parsed.body).not.toContain("vendor: dell");
  });

  // The old graph drifted to 174 relationship types against 20 declared because
  // src/api/knowledge.ts validated labels but never relationships. Every closed
  // vocabulary is therefore enforced at parse time, before anything is written.
  it("rejects a segment outside the closed set", () => {
    expect(() => parseVendorBrief(brief({ segment: "ai-infrastructure" }))).toThrow(/segment.*ai-infrastructure/i);
  });

  it("rejects a position outside the closed set", () => {
    expect(() => parseVendorBrief(brief({ position: "visionary" }))).toThrow(/position.*visionary/i);
  });

  it("rejects a confidence outside the closed set", () => {
    expect(() => parseVendorBrief(brief({ confidence: "certain" }))).toThrow(/confidence.*certain/i);
  });

  it("requires a rationale, because position without it is false confidence", () => {
    expect(() => parseVendorBrief(brief({ rationale: '""' }))).toThrow(/rationale/i);
  });
});

describe("briefToGraphFacts", () => {
  it("emits only closed-set labels and relationship types", () => {
    const facts = briefToGraphFacts(parseVendorBrief(brief()));

    expect(new Set(facts.nodes.map((n) => n.label))).toEqual(new Set(["Vendor", "Segment", "Product"]));
    expect(new Set(facts.relationships.map((r) => r.type))).toEqual(new Set(["OFFERS", "IN_SEGMENT", "COMPETES_IN"]));
  });

  it("carries position, confidence and rationale onto the COMPETES_IN edge", () => {
    const facts = briefToGraphFacts(parseVendorBrief(brief()));
    const competes = facts.relationships.find((r) => r.type === "COMPETES_IN");

    expect(competes).toMatchObject({
      from: "dell",
      to: "storage-block",
      properties: { position: "leader", confidence: "high", asOf: "2026-09-21" },
    });
    expect(competes?.properties.rationale).toBe("Broadest portfolio.");
  });

  it("emits one OFFERS edge per product and no duplicates", () => {
    const facts = briefToGraphFacts(parseVendorBrief(brief()));

    expect(facts.relationships.filter((r) => r.type === "OFFERS")).toHaveLength(2);
    expect(facts.relationships.filter((r) => r.type === "IN_SEGMENT")).toHaveLength(2);
  });

  it("does not invent a node for a competitor it has no brief for", () => {
    // A competitor named in one brief is a claim, not a fact about that vendor.
    // Its own brief is what puts it in a segment.
    const facts = briefToGraphFacts(parseVendorBrief(brief()));

    expect(facts.nodes.map((n) => n.id)).not.toContain("hpe");
  });
});

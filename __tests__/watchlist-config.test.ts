import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { loadWatchlist, parseWatchlist, WatchlistError } from "../src/services/watchlist-config.js";

const MINIMAL = {
  customers: {
    roche: { name: "Roche", aliases: ["Genentech"], peers: ["novartis"], feeds: { rss: ["https://r.example/f.xml"] } },
    novartis: { name: "Novartis", peers: ["roche"], feeds: { edgar: "0001114448" } },
  },
  vendors: { cloud: ["aws"], backup: ["veeam"] },
  topics: { cyber: ["pharma ransomware"] },
};

describe("parseWatchlist", () => {
  it("builds entities for customers, peers and vendors with their feeds", () => {
    const list = parseWatchlist(MINIMAL);

    expect(list.entities.get("roche")).toMatchObject({ name: "Roche", kind: "customer", aliases: ["Genentech"], peers: ["novartis"] });
    expect(list.entities.get("roche")?.feeds).toEqual([{ kind: "rss", url: "https://r.example/f.xml" }]);
    expect(list.entities.get("novartis")?.feeds).toEqual([{ kind: "edgar", cik: "0001114448" }]);
    expect(list.entities.get("aws")).toMatchObject({ kind: "vendor", domains: ["cloud"] });
    expect(list.topics).toEqual([{ query: "pharma ransomware", domains: ["cyber"] }]);
  });

  it("orders priority customers first, then peers, then vendors", () => {
    expect(parseWatchlist(MINIMAL).priority).toEqual(["roche", "novartis", "aws", "veeam"]);
  });

  it("reports every problem at once instead of the first", () => {
    // "ghost" is not itself invalid (a customer's peer with no separate
    // definition always auto-creates, per R3b) -- it is a valid config on
    // its own. This test only throws because "teleportation" is a real
    // domain violation; the "ghost" auto-create note rides along in the same
    // thrown message. See the "surfaces peer notes" tests below for what the
    // "ghost" note actually asserts.
    const broken = {
      customers: { roche: { name: "Roche", peers: ["ghost"] } },
      vendors: { teleportation: ["acme"] },
      topics: { cyber: ["ok"] },
    };

    try {
      parseWatchlist(broken);
      throw new Error("expected WatchlistError");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchlistError);
      expect((err as Error).message).toContain('peer "ghost" referenced by "roche" has no separate definition');
      expect((err as Error).message).toContain("teleportation");
    }
  });

  it("refuses a duplicate id across sections", () => {
    const dup = { customers: { aws: { name: "AWS" } }, vendors: { cloud: ["aws"] }, topics: {} };
    expect(() => parseWatchlist(dup)).toThrow(/aws/);
  });

  it("rejects a non-object document", () => {
    expect(() => parseWatchlist("nope")).toThrow(WatchlistError);
  });

  it("accepts a topic group with no domain under the literal 'none' key (R1)", () => {
    const withNone = {
      customers: {},
      vendors: {},
      topics: { none: ["pharma FDA approval"], cyber: ["pharma ransomware breach"] },
    };

    const list = parseWatchlist(withNone);

    expect(list.topics).toEqual([
      { query: "pharma FDA approval", domains: [] },
      { query: "pharma ransomware breach", domains: ["cyber"] },
    ]);
  });

  it("succeeds on an undefined peer and surfaces a note naming it (R3b)", () => {
    const withOrphanPeer = {
      customers: { roche: { name: "Roche", peers: ["ghost"] } },
      vendors: {},
      topics: {},
    };

    const list = parseWatchlist(withOrphanPeer);

    expect(list.entities.get("ghost")).toMatchObject({ id: "ghost", kind: "peer" });
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0]).toContain('peer "ghost" referenced by "roche" has no separate definition');
  });

  it("merges domains when a vendor id appears in two different groups", () => {
    const twoDomainVendor = {
      customers: {},
      vendors: { ai: ["databricks"], data: ["databricks"] },
      topics: {},
    };

    const list = parseWatchlist(twoDomainVendor);

    expect(list.entities.size).toBe(1);
    expect(list.entities.get("databricks")).toMatchObject({ kind: "vendor", domains: ["ai", "data"] });
    expect(list.priority).toEqual(["databricks"]);
  });

  it("refuses the same vendor id repeated within one group, but still merges it across two groups (R4)", () => {
    const repeatedWithinGroup = {
      customers: {},
      vendors: { cloud: ["aws", "aws"] },
      topics: {},
    };
    expect(() => parseWatchlist(repeatedWithinGroup)).toThrow(/duplicate id "aws" within vendor group "cloud"/);

    const acrossTwoGroups = {
      customers: {},
      vendors: { ai: ["nvidia"], cloud: ["nvidia"] },
      topics: {},
    };
    const list = parseWatchlist(acrossTwoGroups);
    expect(list.entities.get("nvidia")).toMatchObject({ kind: "vendor", domains: ["ai", "cloud"] });
  });
});

describe("loadWatchlist", () => {
  it("loads and parses a YAML file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchlist-config-test-"));
    const filePath = join(dir, "watchlist.yaml");
    try {
      writeFileSync(
        filePath,
        [
          "customers:",
          "  roche:",
          "    name: Roche",
          "    peers: [novartis]",
          "  novartis:",
          "    name: Novartis",
          "vendors:",
          "  cloud: [aws]",
          "topics:",
          "  cyber: [pharma ransomware]",
          "",
        ].join("\n"),
        "utf8",
      );

      const list = loadWatchlist(filePath);

      expect(list.entities.get("roche")).toMatchObject({ kind: "customer" });
      expect(list.entities.get("aws")).toMatchObject({ kind: "vendor", domains: ["cloud"] });
      expect(list.topics).toEqual([{ query: "pharma ransomware", domains: ["cyber"] }]);
      expect(list.priority).toEqual(["roche", "novartis", "aws"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "@jest/globals";
import { parseWatchlist, WatchlistError } from "../src/services/watchlist-config.js";

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
      expect((err as Error).message).toContain("ghost");
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
});

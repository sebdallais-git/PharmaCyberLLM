import { describe, expect, it } from "@jest/globals";
import { buildGatherDeps } from "../src/services/export-wiring.js";

describe("buildGatherDeps", () => {
  it("maps cypher rows into incumbency entries", async () => {
    const deps = buildGatherDeps({
      async runCypher() {
        return [{ account: "roche", segment: "storage-file", vendors: ["dell"] }];
      },
      itemsFor() {
        return [];
      },
    });

    expect(await deps.incumbency()).toEqual([
      { account: "roche", segment: "storage-file", vendors: ["dell"] },
    ]);
  });

  it("maps cypher rows into positions", async () => {
    const deps = buildGatherDeps({
      async runCypher() {
        return [{ segment: "storage-file", position: "strong", confidence: "medium", rationale: "Contested." }];
      },
      itemsFor() {
        return [];
      },
    });

    expect(await deps.positions("dell")).toEqual([
      { segment: "storage-file", position: "strong", confidence: "medium", rationale: "Contested." },
    ]);
  });

  it("reads recent items for an entity from the watchlist", async () => {
    const deps = buildGatherDeps({
      async runCypher() {
        return [];
      },
      itemsFor(entity, limit) {
        expect(entity).toBe("roche");
        expect(limit).toBe(5);
        return [{ title: "Roche builds AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
      },
    });

    expect(await deps.news("roche", 5)).toHaveLength(1);
  });
});

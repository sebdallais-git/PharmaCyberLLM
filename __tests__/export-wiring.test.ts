import { describe, expect, it, jest } from "@jest/globals";
import type { Driver } from "neo4j-driver";
import { buildGatherDeps, liveReader } from "../src/services/export-wiring.js";
import { openWatchlistStore } from "../src/services/watchlist-store.js";

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

  // Fix round 1, finding 2: a raw Neo4j row is Record<string, unknown> --
  // String(r.field) used to coerce a missing/null property straight into the
  // literal text "undefined"/"null" with no guard. These four cases are the
  // ones the fix task called out explicitly: a well-formed row (covered
  // above), a missing required field, a null required field, and a
  // legitimately absent optional field (rationale) that must NOT reject.
  describe("row validation", () => {
    it("rejects an incumbency row with a missing required field, never yielding the string \"undefined\"", async () => {
      const deps = buildGatherDeps({
        async runCypher() {
          return [{ segment: "storage-file", vendors: ["dell"] }]; // account is absent
        },
        itemsFor() {
          return [];
        },
      });

      // Rejecting means incumbency() never resolves to a value at all, so
      // the string "undefined" cannot appear anywhere in its output -- there
      // is no output. Confirmed on the rejection itself: the pre-fix
      // behavior (String(undefined)) would instead have RESOLVED with
      // account: "undefined" and never reached this assertion.
      await expect(deps.incumbency()).rejects.toThrow(/account/);
    });

    it("rejects an incumbency row with a null required field, never yielding the string \"null\"", async () => {
      const deps = buildGatherDeps({
        async runCypher() {
          return [{ account: null, segment: "storage-file", vendors: ["dell"] }];
        },
        itemsFor() {
          return [];
        },
      });

      // Same reasoning as above for null: the pre-fix behavior
      // (String(null)) would have RESOLVED with account: "null" instead of
      // rejecting.
      await expect(deps.incumbency()).rejects.toThrow(/account/);
    });

    it("rejects a positions row missing a required field (position)", async () => {
      const deps = buildGatherDeps({
        async runCypher() {
          return [{ segment: "storage-file", confidence: "medium", rationale: "Contested." }]; // position absent
        },
        itemsFor() {
          return [];
        },
      });

      await expect(deps.positions("dell")).rejects.toThrow(/position/);
    });

    it("does not reject when the optional rationale field is absent (undefined or null)", async () => {
      const deps = buildGatherDeps({
        async runCypher() {
          return [
            { segment: "storage-file", position: "strong", confidence: "medium" }, // rationale undefined
            { segment: "compute", position: "weak", confidence: "low", rationale: null }, // rationale null
          ];
        },
        itemsFor() {
          return [];
        },
      });

      await expect(deps.positions("dell")).resolves.toEqual([
        { segment: "storage-file", position: "strong", confidence: "medium", rationale: "" },
        { segment: "compute", position: "weak", confidence: "low", rationale: "" },
      ]);
    });
  });
});

// Fix round 1, finding 1: liveReader() used to open a fresh watchlist store
// (and driver) on every call, leaking a WAL-mode sqlite handle (three file
// descriptors) per export. It must now be memoised at module scope so a
// second call returns the SAME reader without opening a second store.
//
// getDriver/openStore are injected fakes (a real Driver is never
// constructed, and the watchlist store is an in-memory ":memory:" instance
// -- the same pattern watchlist-store.test.ts uses -- so this test never
// touches a live Neo4j server or writes a database file to disk.
describe("liveReader", () => {
  it("memoises the reader: a second call reuses it instead of opening a second store", () => {
    const store = openWatchlistStore(":memory:");
    const openStore = jest.fn(() => store);
    const fakeDriver = { session: jest.fn() } as unknown as Driver;
    const getDriverFn = jest.fn(() => fakeDriver);

    const first = liveReader({ getDriver: getDriverFn, openStore });
    const second = liveReader({ getDriver: getDriverFn, openStore });

    expect(second).toBe(first);
    expect(openStore).toHaveBeenCalledTimes(1);
    expect(getDriverFn).toHaveBeenCalledTimes(1);

    // A later call passing ENTIRELY DIFFERENT factories must still return
    // the original reader and must NOT invoke those factories -- proving
    // the memo, not argument equality, is what prevents the second open.
    const anotherStore = openWatchlistStore(":memory:");
    const anotherOpenStore = jest.fn(() => anotherStore);
    const anotherGetDriver = jest.fn(() => fakeDriver);

    const third = liveReader({ getDriver: anotherGetDriver, openStore: anotherOpenStore });

    expect(third).toBe(first);
    expect(anotherOpenStore).not.toHaveBeenCalled();
    expect(anotherGetDriver).not.toHaveBeenCalled();

    store.close();
    anotherStore.close();
  });
});

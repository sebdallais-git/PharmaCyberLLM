import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { Domain } from "../src/services/watchlist-config.js";
import { openWatchlistStore, type NewItem, type WatchlistStore } from "../src/services/watchlist-store.js";

const base: NewItem = {
  urlCanonical: "https://a/0",
  contentHash: "h0",
  sourceKind: "rss",
  sourceName: "f",
  title: "t",
  summary: "s",
  signal: "it_move",
  importance: 3,
  publishedAt: "2026-09-12T00:00:00.000Z",
  fetchedAt: "2026-09-12T01:00:00.000Z",
  entities: ["roche"],
  domains: ["cloud"],
};

describe("watchlist store", () => {
  let store: WatchlistStore;

  beforeEach(() => {
    store = openWatchlistStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("stores an item with its entities, domains and sources, and reads it back", () => {
    const id = store.insertItem({
      urlCanonical: "https://a/1",
      contentHash: "h1",
      sourceKind: "rss",
      sourceName: "Roche IR",
      title: "Roche picks a cloud",
      summary: "s",
      signal: "it_move",
      importance: 4,
      publishedAt: "2026-09-18T00:00:00.000Z",
      fetchedAt: "2026-09-19T00:00:00.000Z",
      entities: ["roche", "aws"],
      domains: ["cloud"],
    });
    store.addSource(id, "news", "https://news/1");

    const item = store.findByHash("h1");
    expect(item?.entities.sort()).toEqual(["aws", "roche"]);
    expect(item?.domains).toEqual(["cloud"]);
    expect(item?.urls.sort()).toEqual(["https://a/1", "https://news/1"]);
  });

  it("finds an item by canonical url for dedupe", () => {
    store.insertItem({ ...base, urlCanonical: "https://a/2", contentHash: "h2" });

    expect(store.findByUrl("https://a/2")?.contentHash).toBe("h2");
    expect(store.findByUrl("https://a/never")).toBeNull();
  });

  it("filters a period by entity and domain, newest first", () => {
    store.insertItem({ ...base, urlCanonical: "u1", contentHash: "c1", publishedAt: "2026-09-10T00:00:00.000Z", entities: ["roche"], domains: ["cloud"] });
    store.insertItem({ ...base, urlCanonical: "u2", contentHash: "c2", publishedAt: "2026-09-12T00:00:00.000Z", entities: ["roche"], domains: ["cyber"] });
    store.insertItem({ ...base, urlCanonical: "u3", contentHash: "c3", publishedAt: "2026-09-12T00:00:00.000Z", entities: ["novartis"], domains: ["cloud"] });

    const window = { from: "2026-09-11T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z" };
    expect(store.itemsInPeriod(window.from, window.to).map((i) => i.contentHash)).toEqual(["c2", "c3"]);
    expect(store.itemsInPeriod(window.from, window.to, { entities: ["roche"] }).map((i) => i.contentHash)).toEqual(["c2"]);
    expect(store.itemsInPeriod(window.from, window.to, { domains: ["cloud"] }).map((i) => i.contentHash)).toEqual(["c3"]);
  });

  it("counts items per entity in a period with the highest importance", () => {
    store.insertItem({ ...base, urlCanonical: "u1", contentHash: "c1", entities: ["roche"], importance: 2 });
    store.insertItem({ ...base, urlCanonical: "u2", contentHash: "c2", entities: ["roche", "aws"], importance: 5 });

    expect(store.countsByEntity("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual(
      expect.arrayContaining([
        { entityId: "roche", items: 2, maxImportance: 5 },
        { entityId: "aws", items: 1, maxImportance: 5 },
      ])
    );
  });

  it("tracks feed state: success resets failures, failure increments", () => {
    expect(store.getFeedState("f1")).toEqual({ feedId: "f1", lastSeenAt: null, lastItemHash: null, consecutiveFailures: 0 });
    expect(store.recordFeedFailure("f1")).toBe(1);
    expect(store.recordFeedFailure("f1")).toBe(2);
    store.recordFeedSuccess("f1", "2026-09-19T00:00:00.000Z", "h9");
    expect(store.getFeedState("f1")).toMatchObject({ consecutiveFailures: 0, lastItemHash: "h9" });
  });

  it("records a run's stats", () => {
    const runId = store.startRun("2026-09-19T02:30:00.000Z");
    store.finishRun(runId, "2026-09-19T03:10:00.000Z", { fetched: 40, deduped: 12, tagged: 28, failedFeeds: 1 });

    expect(store.lastRun()).toMatchObject({ id: runId, fetched: 40, deduped: 12, tagged: 28, failedFeeds: 1, finishedAt: "2026-09-19T03:10:00.000Z" });
  });

  it("returns null from lastRun when no run has been recorded", () => {
    expect(store.lastRun()).toBeNull();
  });

  it("allows an item with zero domains (R1: general news carries entities but no IT domain)", () => {
    const id = store.insertItem({ ...base, urlCanonical: "u-nodomain", contentHash: "c-nodomain", domains: [] });

    const item = store.findByHash("c-nodomain");
    expect(item?.domains).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });

  it("allows an item with zero entities (an unassigned item)", () => {
    const id = store.insertItem({ ...base, urlCanonical: "u-noentity", contentHash: "c-noentity", entities: [] });

    const item = store.findByHash("c-noentity");
    expect(item?.entities).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });

  it("rejects an unknown domain at the storage boundary", () => {
    expect(() =>
      store.insertItem({ ...base, urlCanonical: "u-bad-domain", contentHash: "c-bad-domain", domains: ["teleportation"] as unknown as Domain[] })
    ).toThrow();
  });

  it("rejects an unknown signal at the storage boundary", () => {
    expect(() =>
      store.insertItem({ ...base, urlCanonical: "u-bad-signal", contentHash: "c-bad-signal", signal: "teleportation" as unknown as NewItem["signal"] })
    ).toThrow();
  });
});

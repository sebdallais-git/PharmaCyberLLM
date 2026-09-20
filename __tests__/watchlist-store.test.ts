import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // R5: insertItem must be idempotent on a duplicate content_hash or
  // url_canonical, so an ingest orchestrator can call it unconditionally
  // without a check-then-insert race.
  it("is idempotent on a duplicate content_hash: same id, one row, original data kept", () => {
    const id1 = store.insertItem({ ...base, urlCanonical: "https://a/dup-hash-1", contentHash: "c-dup-hash", summary: "original summary", entities: ["roche"] });
    const id2 = store.insertItem({
      ...base,
      urlCanonical: "https://a/dup-hash-2",
      contentHash: "c-dup-hash",
      summary: "should not overwrite",
      entities: ["novartis", "aws"],
    });

    expect(id2).toBe(id1);
    const item = store.findByHash("c-dup-hash");
    expect(item?.summary).toBe("original summary");
    expect(item?.entities).toEqual(["roche"]);

    const matches = store
      .itemsInPeriod("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")
      .filter((i) => i.contentHash === "c-dup-hash");
    expect(matches).toHaveLength(1);
  });

  it("is idempotent on a duplicate url_canonical with a different hash: same id, one row, original data kept", () => {
    const id1 = store.insertItem({ ...base, urlCanonical: "https://a/dup-url", contentHash: "c-dup-url-1" });
    const id2 = store.insertItem({ ...base, urlCanonical: "https://a/dup-url", contentHash: "c-dup-url-2", summary: "should not overwrite" });

    expect(id2).toBe(id1);
    const item = store.findByUrl("https://a/dup-url");
    expect(item?.contentHash).toBe("c-dup-url-1");
    expect(item?.summary).toBe(base.summary);

    const matches = store
      .itemsInPeriod("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")
      .filter((i) => i.urlCanonical === "https://a/dup-url");
    expect(matches).toHaveLength(1);
  });

  it("lets a duplicate insert's returned id be used with addSource to record a second sighting", () => {
    const id1 = store.insertItem({ ...base, urlCanonical: "https://a/dup-sighting-1", contentHash: "c-dup-sighting" });
    const id2 = store.insertItem({ ...base, urlCanonical: "https://a/dup-sighting-2", contentHash: "c-dup-sighting" });
    store.addSource(id2, "news", "https://news/dup-sighting");

    const item = store.findByHash("c-dup-sighting");
    expect(item?.id).toBe(id1);
    expect(item?.urls.sort()).toEqual(["https://a/dup-sighting-1", "https://news/dup-sighting"]);
  });

  // R13/R15: the cross-source title-key lookup Task 7's orchestrator uses as
  // its third and last dedupe step.
  describe("findByTitleKey", () => {
    it("finds an item with the same title key from a different source kind inside the window", () => {
      store.insertItem({
        ...base,
        urlCanonical: "https://a/tk-1",
        contentHash: "c-tk-1",
        titleKey: "roche picks a cloud",
        sourceKind: "rss",
        publishedAt: "2026-09-16T00:00:00.000Z",
      });

      const found = store.findByTitleKey(
        "roche picks a cloud",
        "2026-09-15T00:00:00.000Z",
        "2026-09-21T00:00:00.000Z",
        "news",
      );
      expect(found?.contentHash).toBe("c-tk-1");
      expect(found?.titleKey).toBe("roche picks a cloud");
    });

    it("never matches an item from the same source kind", () => {
      store.insertItem({
        ...base,
        urlCanonical: "https://a/tk-2",
        contentHash: "c-tk-2",
        titleKey: "roche results",
        sourceKind: "rss",
        publishedAt: "2026-09-16T00:00:00.000Z",
      });

      expect(
        store.findByTitleKey("roche results", "2026-09-15T00:00:00.000Z", "2026-09-21T00:00:00.000Z", "rss"),
      ).toBeNull();
    });

    it("never matches outside the published-at window", () => {
      store.insertItem({
        ...base,
        urlCanonical: "https://a/tk-3",
        contentHash: "c-tk-3",
        titleKey: "roche opens a site",
        sourceKind: "rss",
        publishedAt: "2026-09-01T00:00:00.000Z",
      });

      expect(
        store.findByTitleKey("roche opens a site", "2026-09-15T00:00:00.000Z", "2026-09-21T00:00:00.000Z", "news"),
      ).toBeNull();
    });

    it("never matches an item stored without a title key", () => {
      store.insertItem({ ...base, urlCanonical: "https://a/tk-4", contentHash: "c-tk-4", sourceKind: "rss" });

      expect(store.findByTitleKey("", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z", "news")).toBeNull();
    });
  });

  // R6: the join tables declare ON DELETE CASCADE, but that constraint is a
  // no-op unless the deleting connection has foreign_keys enabled. Uses a
  // temp file (not :memory:) so a second raw connection can see the store's
  // committed rows and issue the delete.
  it("enforces ON DELETE CASCADE from items to its join tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchlist-store-cascade-"));
    const dbPath = join(dir, "watchlist.db");
    const cascadeStore = openWatchlistStore(dbPath);
    try {
      const id = cascadeStore.insertItem({ ...base, urlCanonical: "https://a/cascade", contentHash: "c-cascade", entities: ["roche"], domains: ["cloud"] });
      cascadeStore.addSource(id, "news", "https://news/cascade");

      const raw = new Database(dbPath);
      raw.pragma("foreign_keys = ON");
      try {
        raw.prepare("DELETE FROM items WHERE id = ?").run(id);

        const entityCount = raw.prepare("SELECT COUNT(*) AS c FROM item_entities WHERE item_id = ?").get(id) as { c: number };
        const domainCount = raw.prepare("SELECT COUNT(*) AS c FROM item_domains WHERE item_id = ?").get(id) as { c: number };
        const sourceCount = raw.prepare("SELECT COUNT(*) AS c FROM item_sources WHERE item_id = ?").get(id) as { c: number };
        expect(entityCount.c).toBe(0);
        expect(domainCount.c).toBe(0);
        expect(sourceCount.c).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      cascadeStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

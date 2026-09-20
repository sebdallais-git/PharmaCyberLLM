// Ingest orchestrator tests.
//
// Everything is injected: fake adapters, a fake tagger, a fake embed writer
// and an in-memory store. No network, no ChromaDB, no local model, no
// data/watchlist.db -- this suite must never touch a live service.

import { describe, expect, it } from "@jest/globals";
import type { Entity, Feed, TopicQuery, Watchlist } from "../src/services/watchlist-config.js";
import { canonicalUrl, contentHash, titleKey, type RawItem } from "../src/services/watchlist-sources.js";
import type { IrPageResult } from "../src/services/watchlist-edgar.js";
import type { Tagging } from "../src/services/watchlist-tagger.js";
import { openWatchlistStore, type WatchlistStore } from "../src/services/watchlist-store.js";
import {
  computeCandidateIds,
  createIngestRun,
  feedIdFor,
  topicFeedId,
  type IngestDeps,
  type IngestResult,
} from "../src/services/watchlist-ingest.js";

// ---- fixtures ---------------------------------------------------------------

function makeEntity(over: Partial<Entity> & { id: string }): Entity {
  return {
    id: over.id,
    name: over.name ?? over.id,
    kind: over.kind ?? "customer",
    aliases: over.aliases ?? [],
    domains: over.domains ?? [],
    peers: over.peers ?? [],
    feeds: over.feeds ?? [],
  };
}

function makeWatchlist(entities: Entity[], topics: TopicQuery[] = []): Watchlist {
  return {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    topics,
    // Tests build the priority list in the same customers -> peers -> vendors
    // order parseWatchlist produces.
    priority: entities.map((entity) => entity.id),
    notes: [],
  };
}

function rawItem(over: Partial<RawItem> & { title: string; url: string }): RawItem {
  const title = over.title;
  return {
    title,
    url: over.url,
    publishedAt: over.publishedAt ?? "2026-09-18T00:00:00.000Z",
    body: over.body ?? `body of ${title}`,
    sourceKind: over.sourceKind ?? "rss",
    sourceName: over.sourceName ?? "fixture",
    titleKey: over.titleKey ?? titleKey(title),
  };
}

const defaultTagging: Tagging = {
  summary: "a summary",
  entities: [],
  domains: ["cloud"],
  signal: "it_move",
  importance: 3,
  facts: null,
  flagged: false,
};

interface Harness {
  deps: IngestDeps;
  store: WatchlistStore;
  tagCalls: Array<{ item: RawItem; candidateIds: string[] }>;
  embedCalls: Array<{ texts: string[]; metadatas: Record<string, unknown>[] }>;
  rssCalls: Array<{ feed: Feed; entity: Entity; since: string | null }>;
  newsCalls: Array<{ query: string; since: string | null }>;
  edgarCalls: Array<{ cik: string; since: string | null; at: number }>;
  logs: string[];
  run(options?: { since?: string; only?: string[] }): Promise<IngestResult>;
}

interface HarnessOptions {
  watchlist: Watchlist;
  store?: WatchlistStore;
  limit?: number;
  rss?(feed: Feed, entity: Entity, since: string | null): Promise<RawItem[]>;
  news?(query: string, since: string | null): Promise<RawItem[]>;
  edgar?(cik: string, entity: Entity, since: string | null): Promise<RawItem[]>;
  irPage?(url: string, entity: Entity, since: string | null): Promise<IrPageResult>;
  tag?(item: RawItem, candidateIds: string[]): Promise<Tagging>;
  edgarMinIntervalMs?: number;
  now?: Date;
}

function makeHarness(options: HarnessOptions): Harness {
  const store = options.store ?? openWatchlistStore(":memory:");
  const tagCalls: Harness["tagCalls"] = [];
  const embedCalls: Harness["embedCalls"] = [];
  const rssCalls: Harness["rssCalls"] = [];
  const newsCalls: Harness["newsCalls"] = [];
  const edgarCalls: Harness["edgarCalls"] = [];
  const logs: string[] = [];

  const deps: IngestDeps = {
    watchlist: options.watchlist,
    store,
    adapters: {
      async rss(feed, entity, since) {
        rssCalls.push({ feed, entity, since });
        return options.rss !== undefined ? await options.rss(feed, entity, since) : [];
      },
      async news(query, since) {
        newsCalls.push({ query, since });
        return options.news !== undefined ? await options.news(query, since) : [];
      },
      async edgar(cik, entity, since) {
        edgarCalls.push({ cik, since, at: Date.now() });
        return options.edgar !== undefined ? await options.edgar(cik, entity, since) : [];
      },
      async irPage(url, entity, since) {
        return options.irPage !== undefined
          ? await options.irPage(url, entity, since)
          : { items: [], linksScanned: 0, datedLinks: 0 };
      },
    },
    async tag(item, candidateIds) {
      tagCalls.push({ item, candidateIds });
      return options.tag !== undefined ? await options.tag(item, candidateIds) : defaultTagging;
    },
    async embed(texts, metadatas) {
      embedCalls.push({ texts, metadatas });
      return texts.length;
    },
    now: () => options.now ?? new Date("2026-09-20T06:00:00.000Z"),
    limit: options.limit ?? 250,
    log: (line) => logs.push(line),
    edgarMinIntervalMs: options.edgarMinIntervalMs,
  };

  return {
    deps,
    store,
    tagCalls,
    embedCalls,
    rssCalls,
    newsCalls,
    edgarCalls,
    logs,
    run: (runOptions) => createIngestRun(deps)(runOptions),
  };
}

const ALL_TIME = { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

// ---- tests ------------------------------------------------------------------

describe("watchlist ingest", () => {
  it("fetches every due feed and stores its items with their tagging", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [
          rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" }),
          rawItem({ title: "Roche opens a datacentre", url: "https://roche.com/b" }),
        ];
      },
      async tag(item) {
        return { ...defaultTagging, summary: `S:${item.title}` };
      },
    });

    const result = await harness.run();

    expect(result.fetched).toBe(2);
    expect(result.stored).toBe(2);
    expect(result.tagged).toBe(2);
    expect(result.deduped).toBe(0);
    expect(result.failedFeeds).toEqual([]);

    const stored = harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to);
    expect(stored.map((item) => item.summary).sort()).toEqual([
      "S:Roche opens a datacentre",
      "S:Roche picks a cloud",
    ]);
    expect(stored[0].domains).toEqual(["cloud"]);
    expect(stored[0].signal).toBe("it_move");
    harness.store.close();
  });

  it("stores the same article seen by two adapters once, records both urls and tags it once", async () => {
    // Same title and body, different urls: the content hash matches (R15
    // step 2) so the news sighting must never reach the model.
    const title = "Roche picks a cloud";
    const body = "Roche said today it picked a cloud provider.";
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche], [{ query: "roche cloud", domains: ["cloud"] }]),
      async rss() {
        return [rawItem({ title, url: "https://roche.com/a", body })];
      },
      async news() {
        return [
          rawItem({
            title,
            url: "https://news.google.com/rss/articles/OPAQUE",
            body,
            sourceKind: "news",
            sourceName: "Google News",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.fetched).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.deduped).toBe(1);
    expect(harness.tagCalls).toHaveLength(1);

    const stored = harness.store.findByHash(contentHash(title, body));
    expect(stored?.urls.sort()).toEqual(
      [canonicalUrl("https://news.google.com/rss/articles/OPAQUE"), canonicalUrl("https://roche.com/a")].sort(),
    );
    harness.store.close();
  });

  it("dedupes across source kinds on the title key inside the +/-3 day window", async () => {
    // Different url AND different body (Google News re-typesets), so only the
    // title key can catch this pair (R13).
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche], [{ query: "roche", domains: [] }]),
      async rss() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://roche.com/a",
            body: "Publisher copy of the release.",
            publishedAt: "2026-09-16T00:00:00.000Z",
          }),
        ];
      },
      async news() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://news.google.com/rss/articles/OPAQUE",
            body: "A different, re-typeset copy.",
            publishedAt: "2026-09-18T00:00:00.000Z",
            sourceKind: "news",
            sourceName: "Google News",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(1);
    expect(result.deduped).toBe(1);
    expect(harness.tagCalls).toHaveLength(1);
    expect(harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to)).toHaveLength(1);
    harness.store.close();
  });

  it("never matches a title key against another item from the same source kind", async () => {
    // titleKey strips a trailing dash clause, so two genuinely different
    // releases from one company can share a key (R13/R15).
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [
          rawItem({ title: "Roche results - Q3 revenue up", url: "https://roche.com/a", body: "one" }),
          rawItem({ title: "Roche results - new CFO named", url: "https://roche.com/b", body: "two" }),
        ];
      },
    });

    // Both items reduce to the same title key, and both come from "rss".
    expect(titleKey("Roche results - Q3 revenue up")).toBe(titleKey("Roche results - new CFO named"));

    const result = await harness.run();

    expect(result.stored).toBe(2);
    expect(result.deduped).toBe(0);
    expect(harness.tagCalls).toHaveLength(2);
    harness.store.close();
  });

  it("does not match a title key outside the +/-3 day published window", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche], [{ query: "roche", domains: [] }]),
      async rss() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://roche.com/a",
            body: "one",
            publishedAt: "2026-09-10T00:00:00.000Z",
          }),
        ];
      },
      async news() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://news.google.com/rss/articles/OPAQUE",
            body: "two",
            publishedAt: "2026-09-18T00:00:00.000Z",
            sourceKind: "news",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(2);
    expect(result.deduped).toBe(0);
    harness.store.close();
  });

  it("skips an item already stored by a previous run without calling the model", async () => {
    const store = openWatchlistStore(":memory:");
    const title = "Roche picks a cloud";
    const body = "the body";
    store.insertItem({
      urlCanonical: canonicalUrl("https://roche.com/a"),
      contentHash: contentHash(title, body),
      titleKey: titleKey(title),
      sourceKind: "rss",
      sourceName: "Roche",
      title,
      summary: "already summarised",
      signal: "it_move",
      importance: 3,
      publishedAt: "2026-09-18T00:00:00.000Z",
      fetchedAt: "2026-09-19T00:00:00.000Z",
      entities: ["roche"],
      domains: ["cloud"],
    });

    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      store,
      async rss() {
        return [rawItem({ title, url: "https://roche.com/a", body })];
      },
    });

    const result = await harness.run();

    expect(result.deduped).toBe(1);
    expect(result.stored).toBe(0);
    expect(harness.tagCalls).toHaveLength(0);
    expect(harness.embedCalls).toHaveLength(0);
    store.close();
  });

  it("applies the cap in priority order and counts what it drops", async () => {
    const feedOf = (id: string): Feed => ({ kind: "rss", url: `https://${id}.example/feed.xml` });
    const customer = makeEntity({ id: "roche", name: "Roche", kind: "customer", feeds: [feedOf("roche")] });
    const peer = makeEntity({ id: "novartis", name: "Novartis", kind: "peer", feeds: [feedOf("novartis")] });
    const vendor = makeEntity({ id: "aws", name: "Amazon Web Services", kind: "vendor", feeds: [feedOf("aws")] });

    const harness = makeHarness({
      watchlist: makeWatchlist([customer, peer, vendor]),
      limit: 2,
      async rss(_feed, entity) {
        return [rawItem({ title: `${entity.name} does a thing`, url: `https://${entity.id}.example/a` })];
      },
    });

    const result = await harness.run();

    expect(result.fetched).toBe(3);
    expect(result.stored).toBe(2);
    expect(result.skippedByCap).toBe(1);
    expect(harness.tagCalls.map((call) => call.item.title)).toEqual([
      "Roche does a thing",
      "Novartis does a thing",
    ]);
    const storedTitles = harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to).map((item) => item.title).sort();
    expect(storedTitles).toEqual(["Novartis does a thing", "Roche does a thing"]);
    harness.store.close();
  });

  it("does not advance a watermark past items the cap dropped", async () => {
    // The cap defers work, it must not lose it: the next run has to see the
    // items this one refused to tag.
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      limit: 1,
      async rss() {
        return [
          rawItem({ title: "Older", url: "https://roche.com/a", publishedAt: "2026-09-17T00:00:00.000Z" }),
          rawItem({ title: "Newer", url: "https://roche.com/b", publishedAt: "2026-09-19T00:00:00.000Z" }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(1);
    expect(result.skippedByCap).toBe(1);
    expect(harness.store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBe("2026-09-17T00:00:00.000Z");
    harness.store.close();
  });

  it("records a throwing feed as a failure, keeps going, and never advances its watermark", async () => {
    const brokenFeed: Feed = { kind: "rss", url: "https://broken.example/feed.xml" };
    const goodFeed: Feed = { kind: "rss", url: "https://good.example/feed.xml" };
    const broken = makeEntity({ id: "broken", name: "Broken", feeds: [brokenFeed] });
    const good = makeEntity({ id: "good", name: "Good", feeds: [goodFeed] });

    const harness = makeHarness({
      watchlist: makeWatchlist([broken, good]),
      async rss(_feed, entity) {
        if (entity.id === "broken") throw new Error("HTTP 503");
        return [
          rawItem({ title: "Good news", url: "https://good.example/a", publishedAt: "2026-09-18T00:00:00.000Z" }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.failedFeeds).toEqual([feedIdFor(broken, brokenFeed)]);
    expect(result.stored).toBe(1);
    expect(harness.store.getFeedState(feedIdFor(broken, brokenFeed)).consecutiveFailures).toBe(1);
    expect(harness.store.getFeedState(feedIdFor(broken, brokenFeed)).lastSeenAt).toBeNull();
    expect(harness.store.getFeedState(feedIdFor(good, goodFeed)).lastSeenAt).toBe("2026-09-18T00:00:00.000Z");
    harness.store.close();
  });

  it("passes the stored watermark back to the adapter on the next run", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    let batch = 0;
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        batch += 1;
        if (batch > 1) return [];
        return [rawItem({ title: "First", url: "https://roche.com/a", publishedAt: "2026-09-18T00:00:00.000Z" })];
      },
    });

    await harness.run();
    await harness.run();

    expect(harness.rssCalls.map((call) => call.since)).toEqual([null, "2026-09-18T00:00:00.000Z"]);
    harness.store.close();
  });

  it("embeds every stored item once with entity, domain, signal and published_at", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
      async tag() {
        return { ...defaultTagging, entities: ["roche"], domains: ["cloud"], signal: "it_move" };
      },
    });

    await harness.run();

    expect(harness.embedCalls).toHaveLength(1);
    const [call] = harness.embedCalls;
    expect(call.texts).toHaveLength(1);
    expect(call.texts[0]).toContain("Roche picks a cloud");
    const metadata = call.metadatas[0];
    expect(metadata.entity).toBe("roche");
    expect(metadata.domain).toBe("cloud");
    expect(metadata.signal).toBe("it_move");
    expect(metadata.published_at).toBe("2026-09-18T00:00:00.000Z");
    harness.store.close();
  });

  it("records the run with startRun/finishRun", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
    });

    const result = await harness.run();
    const run = harness.store.lastRun();

    expect(run?.id).toBe(result.runId);
    expect(run?.startedAt).toBe("2026-09-20T06:00:00.000Z");
    expect(run?.finishedAt).toBe("2026-09-20T06:00:00.000Z");
    expect(run?.fetched).toBe(1);
    expect(run?.tagged).toBe(1);
    expect(run?.failedFeeds).toBe(0);
    harness.store.close();
  });

  it("records an IR page that scanned links but recognised no dates as an anomaly (R16)", async () => {
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors/reports" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [irFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async irPage() {
        return { items: [], linksScanned: 12, datedLinks: 0 };
      },
    });

    const result = await harness.run();

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toContain("roche");
    expect(result.failedFeeds).toEqual([]);
    harness.store.close();
  });

  it("treats an IR page with no links at all as ordinary silence (R16)", async () => {
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors/reports" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [irFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async irPage() {
        return { items: [], linksScanned: 0, datedLinks: 0 };
      },
    });

    const result = await harness.run();

    expect(result.anomalies).toEqual([]);
    harness.store.close();
  });

  it("rate-limits EDGAR calls across the whole run, and only EDGAR calls (R17)", async () => {
    const entities = ["a", "b", "c"].map((id) =>
      makeEntity({ id, name: id.toUpperCase(), feeds: [{ kind: "edgar", cik: `000000000${id.charCodeAt(0)}` }] }),
    );
    const harness = makeHarness({
      watchlist: makeWatchlist(entities),
      edgarMinIntervalMs: 40,
      async edgar() {
        return [];
      },
    });

    await harness.run();

    expect(harness.edgarCalls).toHaveLength(3);
    const [first, second, third] = harness.edgarCalls;
    expect(second.at - first.at).toBeGreaterThanOrEqual(35);
    expect(third.at - second.at).toBeGreaterThanOrEqual(35);
    harness.store.close();

    // The same three feeds as RSS are not throttled.
    const rssEntities = ["a", "b", "c"].map((id) =>
      makeEntity({ id, name: id.toUpperCase(), feeds: [{ kind: "rss", url: `https://${id}.example/f.xml` }] }),
    );
    const rssHarness = makeHarness({
      watchlist: makeWatchlist(rssEntities),
      edgarMinIntervalMs: 40,
      async rss() {
        return [];
      },
    });
    const startedAt = Date.now();
    await rssHarness.run();
    expect(Date.now() - startedAt).toBeLessThan(40);
    rssHarness.store.close();
  });

  it("gives the tagger the feed's own entity plus entities named in the item", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", aliases: ["Genentech"], feeds: [rssFeed] });
    const novartis = makeEntity({ id: "novartis", name: "Novartis", kind: "peer" });
    const aws = makeEntity({ id: "aws", name: "Amazon Web Services", kind: "vendor", aliases: ["AWS"] });
    const unmentioned = makeEntity({ id: "bayer", name: "Bayer", kind: "peer" });

    const harness = makeHarness({
      watchlist: makeWatchlist([roche, novartis, aws, unmentioned]),
      async rss() {
        return [
          rawItem({
            title: "Genentech and Novartis compare notes",
            url: "https://roche.com/a",
            body: "No cloud vendor was named in this one.",
          }),
        ];
      },
    });

    await harness.run();

    const candidates = harness.tagCalls[0].candidateIds;
    expect(candidates).toContain("roche");
    expect(candidates).toContain("novartis");
    expect(candidates).not.toContain("bayer");
    harness.store.close();
  });

  it("ignores aliases shorter than four characters when building candidates", () => {
    const roche = makeEntity({ id: "roche", name: "Roche" });
    const shortAlias = makeEntity({ id: "gne", name: "Some Vendor", kind: "vendor", aliases: ["GNE"] });
    const watchlist = makeWatchlist([roche, shortAlias]);
    const item = rawItem({
      title: "A GNE update",
      url: "https://x.example/a",
      body: "GNE shipped something; Roche said nothing.",
    });

    const candidates = computeCandidateIds(item, watchlist, null);

    expect(candidates).toContain("roche");
    expect(candidates).not.toContain("gne");
  });

  it("matches names and aliases on word boundaries only", () => {
    const sapEntity = makeEntity({ id: "sap", name: "SAP", kind: "vendor" });
    const watchlist = makeWatchlist([sapEntity]);
    const embedded = rawItem({ title: "Asaptic resins", url: "https://x.example/a", body: "nothing to see" });
    const named = rawItem({ title: "An SAP rollout", url: "https://x.example/b", body: "nothing to see" });

    expect(computeCandidateIds(embedded, watchlist, null)).toEqual([]);
    expect(computeCandidateIds(named, watchlist, null)).toEqual(["sap"]);
  });

  it("runs topic queries as news feeds with their own watermark", async () => {
    const topics: TopicQuery[] = [{ query: "pharma ransomware breach", domains: ["cyber"] }];
    const harness = makeHarness({
      watchlist: makeWatchlist([], topics),
      async news() {
        return [
          rawItem({
            title: "A pharma breach",
            url: "https://news.example/a",
            sourceKind: "news",
            publishedAt: "2026-09-19T00:00:00.000Z",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(harness.newsCalls).toEqual([{ query: "pharma ransomware breach", since: null }]);
    expect(result.stored).toBe(1);
    expect(harness.store.getFeedState(topicFeedId("pharma ransomware breach")).lastSeenAt).toBe(
      "2026-09-19T00:00:00.000Z",
    );
    harness.store.close();
  });

  it("restricts the run to the requested entities with `only`", async () => {
    const rocheFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const novartisFeed: Feed = { kind: "rss", url: "https://novartis.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rocheFeed] });
    const novartis = makeEntity({ id: "novartis", name: "Novartis", feeds: [novartisFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche, novartis], [{ query: "topic", domains: [] }]),
      async rss() {
        return [];
      },
    });

    await harness.run({ only: ["roche"] });

    expect(harness.rssCalls.map((call) => call.entity.id)).toEqual(["roche"]);
    expect(harness.newsCalls).toEqual([]);
    harness.store.close();
  });

  it("overrides every feed's watermark with an explicit `since`", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [];
      },
    });

    await harness.run({ since: "2026-09-01T00:00:00.000Z" });

    expect(harness.rssCalls[0].since).toBe("2026-09-01T00:00:00.000Z");
    harness.store.close();
  });

  it("keeps a stored item when the ChromaDB writer fails, and reports it", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const store = openWatchlistStore(":memory:");
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      store,
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
    });
    harness.deps.embed = async () => {
      throw new Error("chroma down");
    };

    const result = await createIngestRun(harness.deps)();

    expect(result.stored).toBe(1);
    expect(result.failedFeeds).toEqual([]);
    expect(result.anomalies.join(" ")).toContain("embed");
    store.close();
  });

  it("fails the feed, not the run, when the tagger throws", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
      async tag() {
        throw new Error("model offline");
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(0);
    expect(result.failedFeeds).toEqual([feedIdFor(roche, rssFeed)]);
    expect(harness.store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBeNull();
    harness.store.close();
  });
});

// Watchlist item store.
//
// Persists ingested watchlist items (news/filings/etc.) with the entities and
// domains tagged onto them, tracks per-feed fetch state for the ingest loop,
// and records per-run stats. Follows the same better-sqlite3 pattern as
// src/services/feedback-store.ts: WAL journal mode, CREATE TABLE IF NOT
// EXISTS, prepared statements.
//
// R1: an item may legitimately have zero domains (general pharma news with
// no IT angle) and zero entities (unassigned). Both empty sets are valid and
// stored as empty. What must never be stored is an *unknown* domain or
// signal -- those are validated against the closed vocabularies imported
// from watchlist-config.ts at the storage boundary, in insertItem, before
// any row is written.

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { DOMAINS, SIGNALS, type Domain, type Signal } from "./watchlist-config.js";

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);
const SIGNAL_SET: ReadonlySet<string> = new Set(SIGNALS);

function isKnownDomain(value: string): value is Domain {
  return DOMAIN_SET.has(value);
}

function isKnownSignal(value: string): value is Signal {
  return SIGNAL_SET.has(value);
}

export interface StoredItem {
  id: number;
  urlCanonical: string;
  contentHash: string;
  sourceKind: string;
  sourceName: string;
  title: string;
  summary: string;
  signal: Signal | null;
  importance: number | null;
  facts: Record<string, unknown> | null;
  publishedAt: string;
  fetchedAt: string;
  entities: string[];
  domains: Domain[];
  urls: string[];
  flagged: boolean;
}

export interface NewItem {
  urlCanonical: string;
  contentHash: string;
  sourceKind: string;
  sourceName: string;
  title: string;
  summary: string;
  signal: Signal | null;
  importance: number | null;
  facts?: Record<string, unknown> | null;
  publishedAt: string;
  fetchedAt: string;
  entities: string[];
  domains: Domain[];
  flagged?: boolean;
}

export interface FeedState {
  feedId: string;
  lastSeenAt: string | null;
  lastItemHash: string | null;
  consecutiveFailures: number;
}

export interface RunRecord {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  deduped: number;
  tagged: number;
  failedFeeds: number;
}

export interface WatchlistStore {
  insertItem(item: NewItem): number; // returns the item id
  findByHash(contentHash: string): StoredItem | null;
  findByUrl(urlCanonical: string): StoredItem | null;
  addSource(itemId: number, sourceKind: string, url: string): void;
  itemsInPeriod(from: string, to: string, options?: { entities?: string[]; domains?: Domain[] }): StoredItem[];
  countsByEntity(from: string, to: string): Array<{ entityId: string; items: number; maxImportance: number }>;
  getFeedState(feedId: string): FeedState;
  recordFeedSuccess(feedId: string, lastSeenAt: string, lastItemHash: string): void;
  recordFeedFailure(feedId: string): number; // returns consecutiveFailures after increment
  startRun(startedAt: string): number;
  finishRun(runId: number, finishedAt: string, stats: { fetched: number; deduped: number; tagged: number; failedFeeds: number }): void;
  lastRun(): RunRecord | null;
  close(): void;
}

// Raw row shapes as better-sqlite3 hands them back (snake_case columns).
interface ItemRow {
  id: number;
  url_canonical: string;
  content_hash: string;
  source_kind: string;
  source_name: string;
  title: string;
  summary: string;
  signal: string | null;
  importance: number | null;
  facts: string | null;
  published_at: string;
  fetched_at: string;
  flagged: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openWatchlistStore(path: string = join(process.cwd(), "data", "watchlist.db")): WatchlistStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_canonical TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      signal TEXT,
      importance INTEGER,
      facts TEXT,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_content_hash ON items(content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_url_canonical ON items(url_canonical);

    CREATE TABLE IF NOT EXISTS item_entities (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (item_id, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_item_entities_entity_id ON item_entities(entity_id);

    CREATE TABLE IF NOT EXISTS item_domains (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      PRIMARY KEY (item_id, domain)
    );

    CREATE TABLE IF NOT EXISTS item_sources (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (item_id, url)
    );

    CREATE TABLE IF NOT EXISTS feed_state (
      feed_id TEXT PRIMARY KEY,
      last_seen_at TEXT,
      last_item_hash TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      fetched INTEGER,
      deduped INTEGER,
      tagged INTEGER,
      failed_feeds INTEGER
    );
  `);

  // ---- prepared statements -------------------------------------------------

  const insertItemStmt = db.prepare(`
    INSERT INTO items (url_canonical, content_hash, source_kind, source_name, title, summary, signal, importance, facts, published_at, fetched_at, flagged)
    VALUES (@urlCanonical, @contentHash, @sourceKind, @sourceName, @title, @summary, @signal, @importance, @facts, @publishedAt, @fetchedAt, @flagged)
  `);
  const insertEntityStmt = db.prepare(`INSERT OR IGNORE INTO item_entities (item_id, entity_id) VALUES (?, ?)`);
  const insertDomainStmt = db.prepare(`INSERT OR IGNORE INTO item_domains (item_id, domain) VALUES (?, ?)`);
  const insertSourceStmt = db.prepare(`INSERT OR IGNORE INTO item_sources (item_id, source_kind, url) VALUES (?, ?, ?)`);

  const selectItemByHashStmt = db.prepare(`SELECT * FROM items WHERE content_hash = ?`);
  const selectItemByUrlStmt = db.prepare(`SELECT * FROM items WHERE url_canonical = ?`);
  const selectEntitiesStmt = db.prepare(`SELECT entity_id FROM item_entities WHERE item_id = ?`);
  const selectDomainsStmt = db.prepare(`SELECT domain FROM item_domains WHERE item_id = ?`);
  const selectUrlsStmt = db.prepare(`
    SELECT url FROM item_sources WHERE item_id = ?
    UNION
    SELECT url_canonical AS url FROM items WHERE id = ?
  `);

  const selectItemsInPeriodStmt = db.prepare(`
    SELECT * FROM items WHERE published_at >= ? AND published_at <= ? ORDER BY published_at DESC, id ASC
  `);

  const getFeedStateStmt = db.prepare(`SELECT * FROM feed_state WHERE feed_id = ?`);
  const insertFeedStateStmt = db.prepare(`INSERT OR IGNORE INTO feed_state (feed_id, last_seen_at, last_item_hash, consecutive_failures) VALUES (?, NULL, NULL, 0)`);
  const recordFeedSuccessStmt = db.prepare(`
    UPDATE feed_state SET last_seen_at = ?, last_item_hash = ?, consecutive_failures = 0 WHERE feed_id = ?
  `);
  const incrementFeedFailureStmt = db.prepare(`
    UPDATE feed_state SET consecutive_failures = consecutive_failures + 1 WHERE feed_id = ?
  `);

  const startRunStmt = db.prepare(`INSERT INTO runs (started_at) VALUES (?)`);
  const finishRunStmt = db.prepare(`
    UPDATE runs SET finished_at = ?, fetched = ?, deduped = ?, tagged = ?, failed_feeds = ? WHERE id = ?
  `);
  const lastRunStmt = db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`);

  // ---- row -> domain object mapping ----------------------------------------

  function hydrateItem(row: ItemRow): StoredItem {
    const entities = (selectEntitiesStmt.all(row.id) as Array<{ entity_id: string }>).map((r) => r.entity_id);
    const domains = (selectDomainsStmt.all(row.id) as Array<{ domain: string }>).map((r) => r.domain as Domain);
    const urls = (selectUrlsStmt.all(row.id, row.id) as Array<{ url: string }>).map((r) => r.url);

    let facts: Record<string, unknown> | null = null;
    if (row.facts !== null) {
      const parsed: unknown = JSON.parse(row.facts);
      facts = isRecord(parsed) ? parsed : null;
    }

    return {
      id: row.id,
      urlCanonical: row.url_canonical,
      contentHash: row.content_hash,
      sourceKind: row.source_kind,
      sourceName: row.source_name,
      title: row.title,
      summary: row.summary,
      signal: row.signal !== null && isKnownSignal(row.signal) ? row.signal : null,
      importance: row.importance,
      facts,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      entities,
      domains,
      urls,
      flagged: row.flagged === 1,
    };
  }

  // ---- validation -----------------------------------------------------------

  function assertKnownDomains(domains: Domain[]): void {
    for (const domain of domains) {
      if (!isKnownDomain(domain)) {
        throw new Error(`unknown domain "${domain}"`);
      }
    }
  }

  function assertKnownSignal(signal: Signal | null): void {
    if (signal !== null && !isKnownSignal(signal)) {
      throw new Error(`unknown signal "${signal}"`);
    }
  }

  // ---- public API -------------------------------------------------------

  const insertItemTxn = db.transaction((item: NewItem): number => {
    assertKnownDomains(item.domains);
    assertKnownSignal(item.signal);

    const result = insertItemStmt.run({
      urlCanonical: item.urlCanonical,
      contentHash: item.contentHash,
      sourceKind: item.sourceKind,
      sourceName: item.sourceName,
      title: item.title,
      summary: item.summary,
      signal: item.signal,
      importance: item.importance,
      facts: item.facts !== undefined && item.facts !== null ? JSON.stringify(item.facts) : null,
      publishedAt: item.publishedAt,
      fetchedAt: item.fetchedAt,
      flagged: item.flagged ?? false ? 1 : 0,
    });
    const itemId = Number(result.lastInsertRowid);

    for (const entityId of item.entities) {
      insertEntityStmt.run(itemId, entityId);
    }
    for (const domain of item.domains) {
      insertDomainStmt.run(itemId, domain);
    }
    // The canonical URL is itself a source (its ingest origin).
    insertSourceStmt.run(itemId, item.sourceKind, item.urlCanonical);

    return itemId;
  });

  return {
    insertItem(item: NewItem): number {
      return insertItemTxn(item);
    },

    findByHash(contentHash: string): StoredItem | null {
      const row = selectItemByHashStmt.get(contentHash) as ItemRow | undefined;
      return row === undefined ? null : hydrateItem(row);
    },

    findByUrl(urlCanonical: string): StoredItem | null {
      const row = selectItemByUrlStmt.get(urlCanonical) as ItemRow | undefined;
      return row === undefined ? null : hydrateItem(row);
    },

    addSource(itemId: number, sourceKind: string, url: string): void {
      insertSourceStmt.run(itemId, sourceKind, url);
    },

    itemsInPeriod(from: string, to: string, options?: { entities?: string[]; domains?: Domain[] }): StoredItem[] {
      const rows = selectItemsInPeriodStmt.all(from, to) as ItemRow[];
      let items = rows.map(hydrateItem);

      if (options?.entities !== undefined) {
        const wanted = new Set(options.entities);
        items = items.filter((item) => item.entities.some((e) => wanted.has(e)));
      }
      if (options?.domains !== undefined) {
        const wanted = new Set(options.domains);
        items = items.filter((item) => item.domains.some((d) => wanted.has(d)));
      }

      return items;
    },

    countsByEntity(from: string, to: string): Array<{ entityId: string; items: number; maxImportance: number }> {
      const rows = db.prepare(`
        SELECT ie.entity_id AS entityId, COUNT(*) AS items, MAX(COALESCE(i.importance, 0)) AS maxImportance
        FROM item_entities ie
        JOIN items i ON i.id = ie.item_id
        WHERE i.published_at >= ? AND i.published_at <= ?
        GROUP BY ie.entity_id
      `).all(from, to) as Array<{ entityId: string; items: number; maxImportance: number }>;
      return rows;
    },

    getFeedState(feedId: string): FeedState {
      insertFeedStateStmt.run(feedId);
      const row = getFeedStateStmt.get(feedId) as {
        feed_id: string;
        last_seen_at: string | null;
        last_item_hash: string | null;
        consecutive_failures: number;
      };
      return {
        feedId: row.feed_id,
        lastSeenAt: row.last_seen_at,
        lastItemHash: row.last_item_hash,
        consecutiveFailures: row.consecutive_failures,
      };
    },

    recordFeedSuccess(feedId: string, lastSeenAt: string, lastItemHash: string): void {
      insertFeedStateStmt.run(feedId);
      recordFeedSuccessStmt.run(lastSeenAt, lastItemHash, feedId);
    },

    recordFeedFailure(feedId: string): number {
      insertFeedStateStmt.run(feedId);
      incrementFeedFailureStmt.run(feedId);
      const row = getFeedStateStmt.get(feedId) as { consecutive_failures: number };
      return row.consecutive_failures;
    },

    startRun(startedAt: string): number {
      const result = startRunStmt.run(startedAt);
      return Number(result.lastInsertRowid);
    },

    finishRun(runId: number, finishedAt: string, stats: { fetched: number; deduped: number; tagged: number; failedFeeds: number }): void {
      finishRunStmt.run(finishedAt, stats.fetched, stats.deduped, stats.tagged, stats.failedFeeds, runId);
    },

    lastRun(): RunRecord | null {
      const row = lastRunStmt.get() as
        | { id: number; started_at: string; finished_at: string | null; fetched: number | null; deduped: number | null; tagged: number | null; failed_feeds: number | null }
        | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        fetched: row.fetched ?? 0,
        deduped: row.deduped ?? 0,
        tagged: row.tagged ?? 0,
        failedFeeds: row.failed_feeds ?? 0,
      };
    },

    close(): void {
      db.close();
    },
  };
}

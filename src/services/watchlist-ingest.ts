// Watchlist ingest orchestrator.
//
// The nightly run: walk every watched entity's feeds in watchlist priority
// order (customers -> peers -> vendors, then the entity-less topic queries),
// fetch what is new since each feed's own watermark, collapse the same story
// seen through several sources into ONE item, tag the survivors with the
// local model, store them and embed them.
//
// Three properties drive the whole design:
//
//  1. Dedupe happens BEFORE the model (R13/R15). The same release legitimately
//     arrives via a company's IR RSS, via Google News and via EDGAR; tagging it
//     three times would triple the run's cost for nothing. Every duplicate is
//     resolved with store lookups alone and recorded with addSource().
//  2. Tagging is sequential. The local model serves one request at a time, so
//     there is no concurrency here to win anything -- only to queue behind
//     itself and blow the run's time budget.
//  3. A feed never takes the run down with it. Any adapter/tagger/store error
//     is caught per feed: the failure is recorded, the feed's watermark is NOT
//     advanced (so the next run re-fetches what this one missed) and the run
//     moves on to the next feed.
//
// Everything external is injected through IngestDeps -- adapters, the tagger,
// the ChromaDB writer, the clock. This module imports no transport and no
// chromadb-store, which is what lets the whole orchestrator be tested without
// a network, a model or a live collection.

import type { Entity, Feed, Watchlist } from "./watchlist-config.js";
import { canonicalUrl, contentHash, type RawItem } from "./watchlist-sources.js";
import type { IrPageResult } from "./watchlist-edgar.js";
import type { Tagging } from "./watchlist-tagger.js";
import type { WatchlistStore } from "./watchlist-store.js";

// ---- tuning constants -------------------------------------------------------

// R17: the SEC allows 10 requests/second across all of EDGAR and the config
// holds ~46 CIKs. ONE gate in this module covers every EDGAR call in a run;
// no other source is subject to it.
export const EDGAR_MIN_INTERVAL_MS = 100;

// Default items tagged+stored per run. Everything past it is counted in
// skippedByCap, never silently dropped.
export const DEFAULT_INGEST_LIMIT = 250;

// R13/R15: the title-key dedupe only looks this far either side of an item's
// published-at. A title key is a weak key (it strips punctuation and a
// trailing dash clause), so matching it across an unbounded history would
// collapse, say, two years of identically-titled "Q3 results" filings.
export const TITLE_KEY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// Keeps the tagging prompt short with ~71 entities in the watchlist: only a
// handful of candidates ever reach the model.
export const MAX_CANDIDATE_IDS = 8;

// R-candidates: an alias shorter than this is ignored when scanning an item's
// text ("GNE", "AG", "SA" match far too much). An entity's canonical NAME is
// always matched, however short -- "SAP", "AWS" and "IBM" are real names we
// must not lose.
export const MIN_ALIAS_LENGTH = 4;

// ---- public types -----------------------------------------------------------

export interface IngestAdapters {
  rss(feed: Feed, entity: Entity, since: string | null): Promise<RawItem[]>;
  news(query: string, since: string | null): Promise<RawItem[]>;
  edgar(cik: string, entity: Entity, since: string | null): Promise<RawItem[]>;
  // Returns the adapter's full IrPageResult, not a bare RawItem[] (R16): the
  // orchestrator needs linksScanned/datedLinks to tell a broken extraction
  // heuristic apart from a genuinely quiet page.
  irPage(url: string, entity: Entity, since: string | null): Promise<IrPageResult>;
}

export interface IngestDeps {
  watchlist: Watchlist;
  store: WatchlistStore;
  adapters: IngestAdapters;
  tag(item: RawItem, candidateIds: string[]): Promise<Tagging>;
  // The ChromaDB writer (src/services/chromadb-store.ts's addToChromaDB),
  // injected so no test can ever reach a live collection from here.
  embed(texts: string[], metadatas: Record<string, unknown>[]): Promise<number>;
  now(): Date;
  limit: number;
  log(line: string): void;
  // R17's gate interval, overridable only so tests can pace three calls in
  // milliseconds instead of hundreds. Defaults to EDGAR_MIN_INTERVAL_MS.
  edgarMinIntervalMs?: number;
}

export interface IngestResult {
  fetched: number;
  deduped: number;
  tagged: number;
  stored: number;
  skippedByCap: number;
  failedFeeds: string[];
  // R16: things that are not failures but are not normal either -- an IR page
  // whose links yielded no recognizable date, an embedding write that did not
  // land. Kept separate from failedFeeds because they do not stop a feed from
  // advancing its watermark.
  anomalies: string[];
  runId: number;
}

export interface IngestOptions {
  since?: string;
  only?: string[];
}

// ---- feed identity ----------------------------------------------------------

// A feed's stable id in feed_state. Includes the entity so two entities
// sharing a URL (a joint newsroom) keep separate watermarks, and the kind so
// an entity's EDGAR and IR-page feeds never collide.
export function feedIdFor(entity: Entity, feed: Feed): string {
  return `${entity.id}:${feed.kind}:${feed.url ?? feed.cik ?? ""}`;
}

// Topic queries have no entity of their own; their watermark is keyed by the
// query text.
export function topicFeedId(query: string): string {
  return `topic:${query}`;
}

// ---- EDGAR rate limiter (R17) -----------------------------------------------

// A minimum-interval gate: every call returns no sooner than minIntervalMs
// after the previous one was admitted. The reservation (`next`) is taken
// synchronously, so the gate still paces correctly if a future version fetches
// feeds concurrently.
//
// It reads Date.now() rather than deps.now() on purpose: this paces real
// outbound requests against the SEC's real rate limit, and a test's frozen
// clock must not be able to turn the gate off.
function createMinIntervalGate(minIntervalMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const nowMs = Date.now();
    const waitMs = Math.max(0, next - nowMs);
    next = Math.max(nowMs, next) + minIntervalMs;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      });
    }
  };
}

// ---- candidate entities -----------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match that also works either side of a non-ASCII letter (\b is
// defined on \w, which is ASCII-only): "SAP" must not match inside "Asaptic",
// and "Bayer" must not match inside "Bayerische".
function mentions(haystack: string, term: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(haystack);
}

// The candidate list Task 6's tagger prompts with: the feed's own entity (an
// item pulled from Roche's newsroom is about Roche by construction), plus
// every entity whose name or a long-enough alias literally appears in the
// item's title or body. Deliberately small -- it exists to keep the prompt
// short, not to pre-tag the item.
export function computeCandidateIds(item: RawItem, watchlist: Watchlist, feedEntityId: string | null): string[] {
  const ids: string[] = [];
  if (feedEntityId !== null && watchlist.entities.has(feedEntityId)) {
    ids.push(feedEntityId);
  }

  const haystack = `${item.title}\n${item.body}`;
  for (const entity of watchlist.entities.values()) {
    if (ids.includes(entity.id)) continue;
    if (ids.length >= MAX_CANDIDATE_IDS) break;

    const terms = [entity.name, ...entity.aliases.filter((alias) => alias.length >= MIN_ALIAS_LENGTH)];
    if (terms.some((term) => term.length > 0 && mentions(haystack, term))) {
      ids.push(entity.id);
    }
  }

  return ids;
}

// ---- internal task shape ----------------------------------------------------

interface FetchOutcome {
  items: RawItem[];
  anomaly?: string;
}

interface FeedTask {
  feedId: string;
  entity: Entity | null;
  // Human-readable label for logs (never a raw URL with a tracking query).
  label: string;
  fetch(since: string | null): Promise<FetchOutcome>;
}

// ---- the run ----------------------------------------------------------------

export function createIngestRun(deps: IngestDeps): (options?: IngestOptions) => Promise<IngestResult> {
  const limit = deps.limit > 0 ? deps.limit : DEFAULT_INGEST_LIMIT;
  const edgarGate = createMinIntervalGate(deps.edgarMinIntervalMs ?? EDGAR_MIN_INTERVAL_MS);

  function buildTasks(only: string[] | undefined): FeedTask[] {
    const wanted = only === undefined ? null : new Set(only);
    const tasks: FeedTask[] = [];

    // watchlist.priority is already customers -> peers -> vendors, which is
    // exactly the order the cap must consume (a customer's news outranks a
    // vendor's press release).
    for (const entityId of deps.watchlist.priority) {
      const entity = deps.watchlist.entities.get(entityId);
      if (entity === undefined) continue;
      if (wanted !== null && !wanted.has(entityId)) continue;

      for (const feed of entity.feeds) {
        const feedId = feedIdFor(entity, feed);
        const label = `${entity.name} (${feed.kind})`;

        if (feed.kind === "rss") {
          if (feed.url === undefined) {
            deps.log(`skipping ${label}: no url`);
            continue;
          }
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => ({ items: await deps.adapters.rss(feed, entity, since) }),
          });
        } else if (feed.kind === "ir_page") {
          const url = feed.url;
          if (url === undefined) {
            deps.log(`skipping ${label}: no url`);
            continue;
          }
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => {
              const result = await deps.adapters.irPage(url, entity, since);
              // R16: links were found but not one carried a date this
              // heuristic recognizes -- that is a broken extraction, not a
              // quiet page, and it must be visible in the run's stats rather
              // than read as silence. 0 links scanned is ordinary silence.
              const anomaly =
                result.linksScanned > 0 && result.datedLinks === 0
                  ? `ir_page ${entity.id}: ${result.linksScanned} links scanned, 0 dated -- extraction may be broken`
                  : undefined;
              return { items: result.items, anomaly };
            },
          });
        } else if (feed.kind === "edgar") {
          const cik = feed.cik;
          if (cik === undefined) {
            deps.log(`skipping ${label}: no cik`);
            continue;
          }
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => {
              // R17: the one shared gate, taken immediately before the call.
              await edgarGate();
              return { items: await deps.adapters.edgar(cik, entity, since) };
            },
          });
        } else {
          // A "news" feed attached to an entity is a stored Google News query.
          const query = feed.url;
          if (query === undefined) {
            deps.log(`skipping ${label}: no query`);
            continue;
          }
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => ({ items: await deps.adapters.news(query, since) }),
          });
        }
      }
    }

    // Topics have no entity, so `only` (a list of entity ids) excludes them:
    // "only roche" means this run is about Roche, not about Roche plus every
    // generic cyber query.
    if (wanted === null) {
      for (const topic of deps.watchlist.topics) {
        tasks.push({
          feedId: topicFeedId(topic.query),
          entity: null,
          label: `topic "${topic.query}"`,
          fetch: async (since) => ({ items: await deps.adapters.news(topic.query, since) }),
        });
      }
    }

    return tasks;
  }

  return async function run(options: IngestOptions = {}): Promise<IngestResult> {
    const startedAt = deps.now().toISOString();
    const runId = deps.store.startRun(startedAt);

    let fetched = 0;
    let deduped = 0;
    let tagged = 0;
    let stored = 0;
    let skippedByCap = 0;
    const failedFeeds: string[] = [];
    const anomalies: string[] = [];

    const tasks = buildTasks(options.only);
    deps.log(`run ${runId}: ${tasks.length} feeds`);

    for (const task of tasks) {
      const state = deps.store.getFeedState(task.feedId);
      const since = options.since ?? state.lastSeenAt;

      try {
        const outcome = await task.fetch(since);
        if (outcome.anomaly !== undefined) {
          anomalies.push(outcome.anomaly);
          deps.log(`anomaly: ${outcome.anomaly}`);
        }

        fetched += outcome.items.length;
        // The watermark only ever moves over items this run actually
        // RESOLVED -- stored or recognised as a duplicate. An item the cap
        // refused is deferred, not lost: leaving the watermark behind it is
        // what makes the next run fetch it again.
        let newestPublishedAt: string | null = null;
        let newestHash: string | null = null;
        const markResolved = (publishedAt: string, hash: string): void => {
          if (newestPublishedAt === null || publishedAt > newestPublishedAt) {
            newestPublishedAt = publishedAt;
            newestHash = hash;
          }
        };

        for (const item of outcome.items) {
          const urlCanonical = canonicalUrl(item.url);
          const hash = contentHash(item.title, item.body);

          const existingId = findDuplicate(deps.store, item, urlCanonical, hash);
          if (existingId !== null) {
            // A later sighting of a story we already have: record the new
            // url as another source and never call the model (R13/R15).
            deps.store.addSource(existingId, item.sourceKind, urlCanonical);
            deduped += 1;
            markResolved(item.publishedAt, hash);
            continue;
          }

          if (tagged >= limit) {
            // The cap bites in priority order, because tasks are already in
            // priority order. Counted, not silently lost.
            skippedByCap += 1;
            continue; // deliberately NOT resolved: the watermark stays behind it
          }

          // A tagger or store failure here propagates to the per-feed catch
          // below: the feed is marked failed and its watermark stays put, so
          // the next run re-fetches these items rather than losing them.
          const candidateIds = computeCandidateIds(item, deps.watchlist, task.entity?.id ?? null);
          const tagging = await deps.tag(item, candidateIds);
          tagged += 1;

          // The feed's own entity is always attached: an item pulled from
          // Roche's newsroom is about Roche whatever the model returned, and
          // countsByEntity/the digest depend on that link. A topic feed has no
          // entity of its own, so there the model's answer stands alone (R1:
          // zero entities is a legitimate result).
          const entities = [...new Set([...(task.entity !== null ? [task.entity.id] : []), ...tagging.entities])];
          const itemId = deps.store.insertItem({
            urlCanonical,
            contentHash: hash,
            titleKey: item.titleKey,
            sourceKind: item.sourceKind,
            sourceName: item.sourceName,
            title: item.title,
            summary: tagging.summary,
            signal: tagging.signal,
            importance: tagging.importance,
            facts: tagging.facts,
            publishedAt: item.publishedAt,
            fetchedAt: startedAt,
            entities,
            domains: tagging.domains,
            flagged: tagging.flagged,
          });
          stored += 1;
          markResolved(item.publishedAt, hash);

          // The embedding is best-effort: the row is already durable in
          // SQLite, so a ChromaDB outage must not fail the feed and force a
          // re-tag of items we would then dedupe away anyway.
          try {
            await deps.embed(
              [[item.title, tagging.summary, item.body].filter((part) => part.length > 0).join("\n\n")],
              [
                {
                  source: urlCanonical,
                  title: item.title,
                  entity: entities.join(","),
                  domain: tagging.domains.join(","),
                  signal: tagging.signal ?? "",
                  published_at: item.publishedAt,
                  source_kind: item.sourceKind,
                  importance: tagging.importance ?? 0,
                  watchlist_item_id: itemId,
                },
              ],
            );
          } catch (err) {
            const message = `embed failed for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`;
            anomalies.push(message);
            deps.log(message);
          }
        }

        // The watermark only ever advances on a clean pass over a feed. With
        // no items at all, the previous watermark is rewritten unchanged
        // (which also clears the feed's failure streak); a feed that has never
        // produced anything is stamped with this run's start, since `since`
        // was null for it and it genuinely had nothing to give.
        deps.store.recordFeedSuccess(
          task.feedId,
          newestPublishedAt ?? state.lastSeenAt ?? startedAt,
          newestHash ?? state.lastItemHash ?? "",
        );
      } catch (err) {
        const failures = deps.store.recordFeedFailure(task.feedId);
        failedFeeds.push(task.feedId);
        deps.log(
          `feed failed (${failures} in a row): ${task.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    deps.store.finishRun(runId, deps.now().toISOString(), {
      fetched,
      deduped,
      tagged,
      failedFeeds: failedFeeds.length,
    });
    deps.log(
      `run ${runId} done: fetched=${fetched} deduped=${deduped} tagged=${tagged} stored=${stored} ` +
        `skippedByCap=${skippedByCap} failedFeeds=${failedFeeds.length} anomalies=${anomalies.length}`,
    );

    return { fetched, deduped, tagged, stored, skippedByCap, failedFeeds, anomalies, runId };
  };
}

// R13/R15's dedupe ladder, in order, all of it before any model call:
//   1. canonical url  -- the same page reached twice
//   2. content hash   -- the same title+body under two urls
//   3. title key      -- the same story re-typeset and re-linked by an
//                        aggregator, matched ONLY against a different source
//                        kind and only within +/-3 days
// Returns the existing item's id, or null when this really is a new story.
function findDuplicate(
  store: WatchlistStore,
  item: RawItem,
  urlCanonical: string,
  hash: string,
): number | null {
  const byUrl = store.findByUrl(urlCanonical);
  if (byUrl !== null) return byUrl.id;

  const byHash = store.findByHash(hash);
  if (byHash !== null) return byHash.id;

  if (item.titleKey.length === 0) return null;
  const publishedMs = Date.parse(item.publishedAt);
  if (Number.isNaN(publishedMs)) return null;

  const from = new Date(publishedMs - TITLE_KEY_WINDOW_MS).toISOString();
  const to = new Date(publishedMs + TITLE_KEY_WINDOW_MS).toISOString();
  const byTitleKey = store.findByTitleKey(item.titleKey, from, to, item.sourceKind);
  return byTitleKey === null ? null : byTitleKey.id;
}

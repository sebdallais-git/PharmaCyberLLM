// Watchlist CLI.
// Usage:
//   npx tsx scripts/watchlist.ts verify-feeds

import type { Entity, Feed } from "../src/services/watchlist-config.js";
import { loadWatchlist } from "../src/services/watchlist-config.js";
import { createFetch, DEFAULT_FEED_TIMEOUT_MS, DEFAULT_USER_AGENT, verifyFeed } from "../src/services/watchlist-sources.js";

// R9: DEFAULT_USER_AGENT is honest about who we are, in the form sites'
// bot rules accept -- EDGAR's stricter declared-UA requirement is Task 5's
// concern, not this CLI's.
const USER_AGENT = DEFAULT_USER_AGENT;
// Shared with verifyFeed's own default (fix round 1) so the CLI and the
// library default don't drift apart as two separate "10 seconds" literals.
const FEED_TIMEOUT_MS = DEFAULT_FEED_TIMEOUT_MS;
const MAX_CONCURRENT_REQUESTS = 2;

// Runs fn over items with at most `limit` in flight at once, preserving no
// particular completion order (each call's own console.log is what matters,
// not the return value here).
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = items[nextIndex];
      nextIndex += 1;
      await fn(current);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

interface FeedTask {
  entity: Entity;
  feed: Feed;
}

// Loads config/watchlist.yaml, verifies every listed feed (10s timeout each,
// at most 2 concurrent requests), and prints one result line per feed, then
// the config's notes (e.g. auto-created peers) so gaps stay visible.
async function verifyFeeds(): Promise<void> {
  const watchlist = loadWatchlist();
  const fetchImpl = createFetch({ userAgent: USER_AGENT, timeoutMs: FEED_TIMEOUT_MS });

  const tasks: FeedTask[] = [];
  for (const entity of watchlist.entities.values()) {
    for (const feed of entity.feeds) {
      tasks.push({ entity, feed });
    }
  }

  let failures = 0;

  await mapWithConcurrency(tasks, MAX_CONCURRENT_REQUESTS, async ({ entity, feed }) => {
    // verifyFeed only knows how to judge an RSS/Atom body. "edgar" (a CIK,
    // not a URL) and "ir_page" (an HTML landing page, not a feed) were
    // verified by other means during feed research (an EDGAR company_tickers
    // cross-check, a plain HTTP 200 check) -- running them through the RSS
    // parser would always report a spurious FAIL, not a real problem with the
    // recorded feed. EDGAR's own strict-UA verification is a later task's
    // concern (R9 discussion), not this command's.
    if (feed.kind !== "rss" && feed.kind !== "news") {
      console.log(`skip ${entity.id} ${feed.kind} verified separately during feed research, not RSS/Atom`);
      return;
    }
    let result = await verifyFeed(feed, fetchImpl);
    if (!result.ok && result.error === "HTTP 403") {
      // A couple of Q4-hosted IR platforms (ir.veeva.com, ir.schrodinger.com) have
      // been observed to 403 under this run's concurrent request pattern but pass
      // reliably in isolation or on an immediate retry -- a rate-limiting artifact,
      // not a dead feed. One retry after a short pause absorbs that without masking
      // a genuinely dead/blocked feed (which fails the same way again).
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await verifyFeed(feed, fetchImpl);
    }
    if (result.ok) {
      console.log(`ok ${entity.id} ${feed.kind} ${result.items} newest=${result.newest}`);
    } else {
      failures += 1;
      console.log(`FAIL ${entity.id} ${feed.kind} ${result.error}`);
    }
  });

  if (watchlist.notes.length > 0) {
    console.log("");
    console.log("Notes:");
    for (const note of watchlist.notes) {
      console.log(`- ${note}`);
    }
  }

  if (tasks.length === 0) {
    console.log("No feeds configured yet.");
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (command === "verify-feeds") {
    await verifyFeeds();
    return;
  }

  console.error("Usage: watchlist.ts verify-feeds");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

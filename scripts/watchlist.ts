// Watchlist CLI.
// Usage:
//   npx tsx scripts/watchlist.ts verify-feeds

import type { Entity, Feed } from "../src/services/watchlist-config.js";
import { loadWatchlist } from "../src/services/watchlist-config.js";
import { createFetch, verifyFeed } from "../src/services/watchlist-sources.js";

const USER_AGENT = "PharmaLLM-Watchlist/1.0 (+https://github.com/sebdallais-git/claude-workspace)";
const FEED_TIMEOUT_MS = 10_000;
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
    const result = await verifyFeed(feed, fetchImpl);
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

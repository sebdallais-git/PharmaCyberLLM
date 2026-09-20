// Automated news agent.
//
// Owner decision (post-live-changes, R20's sibling ruling): the 188 topic
// queries this module used to scrub daily via Google News RSS now belong
// solely to the watchlist's 02:30 ingest, which already fetches every one of
// them as `news` feeds (config/watchlist.yaml's `topics:` section) with its
// own dedupe ladder. Running both jobs against the same 188 strings meant
// the same articles were fetched and embedded into the same ChromaDB
// collection TWICE a day, under different metadata, with no dedupe shared
// between the two jobs.
//
// This module therefore no longer fetches those queries or ingests their
// results: runNewsScrub does nothing but touch its own state file. Every
// other caller-visible piece is unchanged on purpose:
//   - the guard checks in runNewsAgent (benchmark mode, index health, model
//     reachability) still gate whether the job runs at all, so a future
//     non-topic scrub can be dropped into runNewsScrub without redoing them;
//   - the state file (.agent-state.json) is still read and written, so
//     `lastRun` stays a true record of when the job last executed;
//   - runNewsAgent's return shape ({ newArticles, topics }) is a tool
//     contract -- src/api/agent.ts's POST /api/agent/run and the MCP
//     `run_news_agent` tool build their reply from it -- so it is kept and
//     now always reports zero rather than being changed or removed;
//   - getAgentTopics() keeps returning the watchlist's topic list: it feeds
//     GET /api/agent/status and the MCP `news_agent_status` tool, and those
//     are read for visibility into what the watchlist is covering, not as a
//     claim that this module fetches them itself.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getLlmClient } from "./llm-client.js";
import { getIndexStatus } from "./index-guard.js";
import { isBenchmarkActive, trackJob } from "./bench-mode.js";
import { loadWatchlist, type Watchlist } from "./watchlist-config.js";

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");
const AGENT_STATE_PATH = join(KNOWLEDGE_DIR, ".agent-state.json");

interface AgentState {
  lastRun: string;
  seenTitles: string[];
}

// Topics tracked for reporting/visibility only (GET /api/agent/status, the
// MCP `news_agent_status` tool) -- config/watchlist.yaml's `topics:` section
// is the single source of truth for what the watchlist ingest fetches, and
// this module no longer fetches any of it itself (see the header comment).
//
// I2: read lazily, memoized, and never allowed to throw. This used to be a
// module-scope `loadWatchlist()` call, and src/server.ts imports this module
// -- so a typo in config/watchlist.yaml (a file the README tells the owner to
// edit, and he edits it from an iPad) took the whole PharmaLLM server down at
// boot, with a YAML error for a stack trace. A broken config must cost the
// news agent its topic list for the night, nothing more.
export function createTopicsLoader(load: () => Watchlist): () => string[] {
  let cache: string[] | null = null;
  return () => {
    if (cache === null) {
      try {
        cache = load().topics.map((topic) => topic.query);
      } catch (err) {
        // Logged once (the memo holds the empty list afterwards), so a broken
        // config is loud in the server log without being repeated per scrub.
        console.error(
          `[News Agent] config/watchlist.yaml could not be read (${
            err instanceof Error ? err.message : String(err)
          }); continuing with no search topics until it is fixed`,
        );
        cache = [];
      }
    }
    return cache;
  };
}

const watchlistSearchTopics = createTopicsLoader(() => loadWatchlist());

async function loadAgentState(): Promise<AgentState> {
  try {
    const data = await readFile(AGENT_STATE_PATH, "utf-8");
    return JSON.parse(data) as AgentState;
  } catch {
    return { lastRun: "", seenTitles: [] };
  }
}

async function saveAgentState(state: AgentState): Promise<void> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  await writeFile(AGENT_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export async function runNewsAgent(): Promise<{ newArticles: number; topics: number }> {
  const skipped = { newArticles: 0, topics: 0 };

  if (isBenchmarkActive()) {
    console.log("[News Agent] Skipped — benchmark mode is active");
    return skipped;
  }
  const indexStatus = getIndexStatus();
  if (!indexStatus.ok) {
    console.warn(`[News Agent] Skipped — ${indexStatus.reason}`);
    return skipped;
  }
  const llm = getLlmClient();
  if (!(await llm.isReachable())) {
    console.warn(`[News Agent] Skipped — the ${llm.stack.name} stack is not reachable`);
    return skipped;
  }

  return trackJob("news-agent", runNewsScrub);
}

// No longer fetches or ingests anything (see the header comment): the 188
// topic queries this used to scrub belong to the watchlist ingest now. Still
// touches its own state file so `lastRun` keeps recording when the job last
// executed, and still returns the shape callers depend on -- zeros, honestly,
// rather than a number that would imply work that no longer happens here.
//
// Exported so tests can call it directly without going through
// runNewsAgent's guard checks -- one of which (llm.isReachable()) makes a
// real network probe and must never run in a test. Production code always
// reaches this through runNewsAgent.
export async function runNewsScrub(): Promise<{ newArticles: number; topics: number }> {
  console.log(
    "[News Agent] Topic scrub retired — the watchlist ingest now owns the 188 topic queries. Nothing to do.",
  );

  const state = await loadAgentState();
  state.lastRun = new Date().toISOString();
  await saveAgentState(state);

  return { newArticles: 0, topics: 0 };
}

export function getAgentTopics(): string[] {
  return [...watchlistSearchTopics()];
}

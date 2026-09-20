// Automated news agent - scrubs the web daily for pharma and cyber threat news

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestText, saveIndex, getStats } from "./knowledge-store.js";
import { addToChromaDB, isChromaDBAvailable } from "./chromadb-store.js";
import { saveRawDocument } from "./raw-documents.js";
import { isNeo4jAvailable, writeEntities } from "./graph-store.js";
import type { GraphEntity, GraphRelationship } from "./graph-store.js";
import { getLlmClient } from "./llm-client.js";
import { getIndexStatus } from "./index-guard.js";
import { isBenchmarkActive, trackJob } from "./bench-mode.js";
import { loadWatchlist, type Watchlist } from "./watchlist-config.js";

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");
const AGENT_STATE_PATH = join(KNOWLEDGE_DIR, ".agent-state.json");

interface NewsItem {
  title: string;
  date: string;
  source: string;
  link: string;
}

interface AgentState {
  lastRun: string;
  seenTitles: string[];
}

// Topics to monitor - pharma business, science, news, cyber threats, and IT
// vendors. Moved out of this file and into config/watchlist.yaml's `topics:`
// section (Task 1 of the IT scene watchlist, Task 8 wired this read): that
// file is now the single source of truth for what this scrub searches for,
// so a topic can be added or retired in one place instead of two drifting
// lists. Every one of the 188 strings this constant used to hold verbatim
// is still present in config/watchlist.yaml, split across its topic groups.
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

async function fetchGoogleNewsRSS(query: string): Promise<NewsItem[]> {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });

  try {
    const response = await fetch(
      `https://news.google.com/rss/search?${params}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) return [];

    const xml = await response.text();
    const items: NewsItem[] = [];

    const xmlItems = xml.split("<item>");
    for (let i = 1; i < xmlItems.length && items.length < 5; i++) {
      const item = xmlItems[i];
      const title = extractTag(item, "title");
      const pubDate = extractTag(item, "pubDate");
      const link = extractTag(item, "link");

      // Extract source from title (format: "Title - Source Name")
      const parts = title.split(" - ");
      const source = parts.length > 1 ? parts.pop()! : "Unknown";
      const cleanTitle = parts.join(" - ");

      if (cleanTitle) {
        items.push({
          title: decodeEntities(cleanTitle),
          date: pubDate ? formatDate(pubDate) : new Date().toISOString().split("T")[0],
          source: decodeEntities(source),
          link,
        });
      }
    }

    return items;
  } catch {
    return [];
  }
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  if (match) return match[1].trim();
  const simpleRegex = new RegExp(`<${tag}>([^<]*)`);
  const simpleMatch = xml.match(simpleRegex);
  return simpleMatch ? simpleMatch[1].trim() : "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toISOString().split("T")[0];
  } catch {
    return dateStr;
  }
}

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

async function extractNewsEntities(texts: string[]): Promise<void> {
  try {
    const neo4jOk = await isNeo4jAvailable();
    if (!neo4jOk) return;

    // Batch all new articles into a single extraction call
    const combined = texts.slice(0, 50).join("\n\n---\n\n").slice(0, 12000);

    const extractionPrompt = `You are an entity extraction engine. Extract entities and relationships from these news items.
Entity types: Company, Subsidiary, Drug, TherapeuticArea, ManufacturingSite, Country, RegulatoryBody, Regulation, ThreatActor, Attack, AttackVector, Vendor, Product, Technology
Return ONLY valid JSON: {"entities": [{"type": "...", "name": "...", "properties": {...}}], "relationships": [{"from": "...", "fromType": "...", "to": "...", "toType": "...", "type": "...", "properties": {...}}]}`;

    const response = await trackJob("graph-extraction", () =>
      getLlmClient().chat(
        [
          { role: "system", content: extractionPrompt },
          { role: "user", content: combined },
        ],
        { temperature: 0.1 }
      )
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]) as {
      entities?: Array<{ type: string; name: string; properties: Record<string, unknown> }>;
      relationships?: Array<{
        from: string; fromType: string; to: string; toType: string;
        type: string; properties: Record<string, unknown>;
      }>;
    };

    const entities: GraphEntity[] = (data.entities ?? []).map((e) => ({
      type: e.type,
      name: e.name,
      properties: Object.fromEntries(
        Object.entries(e.properties ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")
      ),
    }));

    const relationships: GraphRelationship[] = (data.relationships ?? []).map((r) => ({
      from: r.from,
      fromType: r.fromType,
      to: r.to,
      toType: r.toType,
      type: r.type.replace(/\s+/g, "_").toUpperCase(),
      properties: Object.fromEntries(
        Object.entries(r.properties ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")
      ),
    }));

    if (entities.length > 0 || relationships.length > 0) {
      const result = await writeEntities(entities, relationships);
      console.log(`[News Agent] Graph: ${result.nodesProcessed} nodes, ${result.relsProcessed} rels from ${texts.length} articles`);
    }
  } catch (err) {
    console.error("[News Agent] Graph entity extraction failed:", err instanceof Error ? err.message : err);
  }
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

async function runNewsScrub(): Promise<{ newArticles: number; topics: number }> {
  console.log("[News Agent] Starting daily news scrub...");

  const state = await loadAgentState();
  const seenSet = new Set(state.seenTitles);
  let newArticles = 0;
  let topicsProcessed = 0;
  const newTexts: string[] = [];

  const chromaOk = await isChromaDBAvailable().catch(() => false);

  for (const topic of watchlistSearchTopics()) {
    const items = await fetchGoogleNewsRSS(topic);
    topicsProcessed++;

    for (const item of items) {
      // Skip duplicates
      if (seenSet.has(item.title)) continue;

      // Format as knowledge text
      const text = `[${item.date}] ${item.title}\nSource: ${item.source}\nURL: ${item.link}`;
      const sourceName = `news-${item.date}`;

      // 1. Raw document: lets every stack's index be rebuilt from disk
      // 2. In-memory store (awaited so saveIndex below includes the embedding)
      // One failing article is skipped rather than aborting the whole run
      try {
        await saveRawDocument(
          sourceName,
          text,
          { type: "news", link: item.link, title: item.title },
          { key: item.link || text }
        );
        await ingestText(text, sourceName);
      } catch (err) {
        // Not marked as seen, so the next run retries it
        console.error(`[News Agent] Skipped article "${item.title}":`, err instanceof Error ? err.message : err);
        continue;
      }
      seenSet.add(item.title);

      // 3. ChromaDB (persistent vector store)
      if (chromaOk) {
        try {
          await addToChromaDB([text], [{ source: sourceName }]);
        } catch (err) {
          console.error(`[News Agent] ChromaDB ingest failed:`, err instanceof Error ? err.message : err);
        }
      }

      newTexts.push(text);
      newArticles++;
    }

    // Small delay between requests to be polite
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (newArticles > 0) {
    await saveIndex();
  }

  // 4. Neo4j graph extraction (batched, non-blocking)
  if (newTexts.length > 0) {
    setImmediate(() => {
      extractNewsEntities(newTexts).catch((err) =>
        console.error("[News Agent] Graph extraction error:", err instanceof Error ? err.message : err)
      );
    });
  }

  // Keep only last 2000 seen titles to avoid unbounded growth
  const seenArray = [...seenSet];
  state.seenTitles = seenArray.slice(-2000);
  state.lastRun = new Date().toISOString();
  await saveAgentState(state);

  const stats = getStats();
  console.log(`[News Agent] Done. ${newArticles} new articles ingested. Total chunks: ${stats.totalChunks}`);
  return { newArticles, topics: topicsProcessed };
}

export function getAgentTopics(): string[] {
  return [...watchlistSearchTopics()];
}

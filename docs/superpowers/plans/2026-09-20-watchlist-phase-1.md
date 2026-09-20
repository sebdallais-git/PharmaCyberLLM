# IT Scene Watchlist — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect, deduplicate, tag and store items about the watched entities (Roche, Novartis, Sandoz, their peers, and the IT vendor scene) every night, so that filtered Q&A works and Phase 2 has data to digest.

**Architecture:** A committed `config/watchlist.yaml` defines entities, their feeds and the closed tagging vocabulary. Four source adapters (`rss`, `edgar`, `ir_page`, `news`) return normalised items. An orchestrator deduplicates before any model call, tags each survivor with one strict-JSON local-model call restricted to known ids, writes rows to a new SQLite store (`data/watchlist.db`) and embeds the same item into ChromaDB with entity/domain/signal metadata. A nightly CLI run, scheduled clear of the existing Hermes jobs, drives it.

**Tech Stack:** TypeScript strict (Node 22, ES modules), `better-sqlite3` (already a dependency, pattern in `src/services/feedback-store.ts`), `yaml` (currently devDependency — must move to dependencies), the local model via `src/services/llm-client.ts`, ChromaDB via `src/services/chromadb-store.ts`, Jest.

**Spec:** `docs/superpowers/specs/2026-09-20-it-scene-watchlist-design.md`

## Global Constraints

- **Everything local.** No cloud model for summarising, tagging or embedding. Only fetching touches the internet.
- **Tests never touch live services.** No real ChromaDB (a subagent's tests wiped the live collection twice in this project's history), no real Hermes, no real network, no live model. Every fetcher, model call, clock and path is injected. Never import `chromadb-store.js` from a test; the orchestrator takes a writer function.
- TypeScript strict, ES modules, interfaces over type aliases, no `any` (use `unknown` + type guards), camelCase functions, kebab-case files. Comments in English.
- Domains (closed set): `cyber, ai, cloud, infrastructure, rnd_it, mfg_it, sap, data, storage, backup`. Signals (closed set): `it_move, financial, cyber, corporate`. Importance: integer 1–5.
- Entity ids are the tagging vocabulary: the model may return only ids present in the loaded watchlist; anything else is dropped. An item with no entity keeps its domains and is stored unassigned.
- Dedupe happens **before** any model call, on canonical URL and content hash.
- Per-run item cap (default 250) applied in priority order: customers → peers → vendors → topics.
- Never log or store credentials. EDGAR requests send a declared User-Agent (`PharmaLLM/1.0 (sebdallais@gmail.com)`).
- Run `npm run typecheck`, `npm run typecheck:tests`, and `CI=true npm run test` (Jest enters watch mode without `CI=true`).
- Commits: `feat:`/`fix:`/`test:`/`docs:`, ending with the Co-Authored-By trailer the session's attribution instructions give.
- Never touch `.env`, `/legacy`, `data/run/`, or the live `data/gap_log.db`.

## File Structure

| File | Responsibility |
|---|---|
| `config/watchlist.yaml` (create) | Entities, aliases, feeds, peer sets, vendor domains, topic queries |
| `src/services/watchlist-config.ts` (create) | Parse + validate the YAML into typed structures; closed vocabularies |
| `src/services/watchlist-store.ts` (create) | SQLite schema and repository (items, entities, domains, sources, feed state, runs) |
| `src/services/watchlist-sources.ts` (create) | Adapter interface + `rss` and `news` adapters |
| `src/services/watchlist-edgar.ts` (create) | `edgar` and `ir_page` adapters |
| `src/services/watchlist-tagger.ts` (create) | Prompt, strict-JSON parsing, closed-vocabulary validation |
| `src/services/watchlist-ingest.ts` (create) | Orchestrator: due feeds, fetch, dedupe, cap, tag, store, embed |
| `scripts/watchlist.ts` (create) | CLI: `verify-feeds`, `ingest [--limit] [--since]`, `status` |
| `__tests__/watchlist-*.test.ts` (create) | One suite per module, all with injected fakes |

---

### Task 1: Watchlist config schema and loader

**Files:**
- Create: `config/watchlist.yaml` (skeleton: the three customers with empty `feeds`, full peer id lists, vendor lists, topics moved from `news-agent.ts`)
- Create: `src/services/watchlist-config.ts`
- Modify: `package.json` (move `yaml` from devDependencies to dependencies)
- Test: `__tests__/watchlist-config.test.ts`

**Interfaces:**
- Produces:
```ts
export const DOMAINS = ["cyber","ai","cloud","infrastructure","rnd_it","mfg_it","sap","data","storage","backup"] as const;
export type Domain = (typeof DOMAINS)[number];
export const SIGNALS = ["it_move","financial","cyber","corporate"] as const;
export type Signal = (typeof SIGNALS)[number];
export type EntityKind = "customer" | "peer" | "vendor";
export interface Feed { kind: "rss" | "edgar" | "ir_page" | "news"; url?: string; cik?: string; verifiedAt?: string; note?: string }
export interface Entity { id: string; name: string; kind: EntityKind; aliases: string[]; domains: Domain[]; peers: string[]; feeds: Feed[] }
export interface TopicQuery { query: string; domains: Domain[] }
export interface Watchlist { entities: Map<string, Entity>; topics: TopicQuery[]; priority: string[] }
export function parseWatchlist(raw: unknown): Watchlist;            // throws WatchlistError with every problem listed
export function loadWatchlist(path?: string): Watchlist;            // default config/watchlist.yaml
export class WatchlistError extends Error {}
```
  `priority` is the ingest order: customer ids, then peer ids, then vendor ids, each in config order.

- [ ] **Step 1: Write the failing test.** Create `__tests__/watchlist-config.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { parseWatchlist, WatchlistError } from "../src/services/watchlist-config.js";

const MINIMAL = {
  customers: {
    roche: { name: "Roche", aliases: ["Genentech"], peers: ["novartis"], feeds: { rss: ["https://r.example/f.xml"] } },
    novartis: { name: "Novartis", peers: ["roche"], feeds: { edgar: "0001114448" } },
  },
  vendors: { cloud: ["aws"], backup: ["veeam"] },
  topics: { cyber: ["pharma ransomware"] },
};

describe("parseWatchlist", () => {
  it("builds entities for customers, peers and vendors with their feeds", () => {
    const list = parseWatchlist(MINIMAL);

    expect(list.entities.get("roche")).toMatchObject({ name: "Roche", kind: "customer", aliases: ["Genentech"], peers: ["novartis"] });
    expect(list.entities.get("roche")?.feeds).toEqual([{ kind: "rss", url: "https://r.example/f.xml" }]);
    expect(list.entities.get("novartis")?.feeds).toEqual([{ kind: "edgar", cik: "0001114448" }]);
    expect(list.entities.get("aws")).toMatchObject({ kind: "vendor", domains: ["cloud"] });
    expect(list.topics).toEqual([{ query: "pharma ransomware", domains: ["cyber"] }]);
  });

  it("orders priority customers first, then peers, then vendors", () => {
    expect(parseWatchlist(MINIMAL).priority).toEqual(["roche", "novartis", "aws", "veeam"]);
  });

  it("reports every problem at once instead of the first", () => {
    const broken = {
      customers: { roche: { name: "Roche", peers: ["ghost"] } },
      vendors: { teleportation: ["acme"] },
      topics: { cyber: ["ok"] },
    };

    try {
      parseWatchlist(broken);
      throw new Error("expected WatchlistError");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchlistError);
      expect((err as Error).message).toContain("ghost");
      expect((err as Error).message).toContain("teleportation");
    }
  });

  it("refuses a duplicate id across sections", () => {
    const dup = { customers: { aws: { name: "AWS" } }, vendors: { cloud: ["aws"] }, topics: {} };
    expect(() => parseWatchlist(dup)).toThrow(/aws/);
  });

  it("rejects a non-object document", () => {
    expect(() => parseWatchlist("nope")).toThrow(WatchlistError);
  });
});
```

- [ ] **Step 2: Run it and check that it fails.** `CI=true npm run test -- __tests__/watchlist-config.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/services/watchlist-config.ts`.** Parse with `unknown` + type guards (no `any`). Rules: a customer's `peers` become entities of kind `peer` if not otherwise defined; a peer defined in a later customer's list is not duplicated; vendor group keys must be domains; ids are unique across all sections; every peer id must resolve. Collect all problems into one `WatchlistError` whose message lists them one per line. `loadWatchlist` reads the file and calls `parse` with `yaml`'s `parse`.

- [ ] **Step 4: Create `config/watchlist.yaml`** with the three customers (peer lists from the spec, `feeds:` left empty — Task 3 fills them), the ten vendor groups from the spec, and the topic strings moved verbatim from `SEARCH_TOPICS` in `src/services/news-agent.ts`, split into `cyber` and `storage` groups. Do not delete `SEARCH_TOPICS` yet: Task 8 re-points the news agent.

- [ ] **Step 5: Move `yaml` to dependencies.** `npm pkg delete devDependencies.yaml && npm install yaml --save`. Confirm `package-lock.json` changed.

- [ ] **Step 6: Run the tests and typecheck.** `CI=true npm run test -- __tests__/watchlist-config.test.ts && npm run typecheck && npm run typecheck:tests`. Then check the real config loads: `npx tsx -e "import {loadWatchlist} from './src/services/watchlist-config.js'; const w=loadWatchlist(); console.log(w.entities.size, 'entities', w.topics.length, 'topics')"`. Expected: a count, no throw.

- [ ] **Step 7: Commit.**

```bash
git add config/watchlist.yaml src/services/watchlist-config.ts __tests__/watchlist-config.test.ts package.json package-lock.json
git commit -m "feat: define the watchlist config and its loader"
```

---

### Task 2: Item store

**Files:**
- Create: `src/services/watchlist-store.ts`
- Test: `__tests__/watchlist-store.test.ts`

**Interfaces:**
- Consumes: `Domain`, `Signal` from Task 1.
- Produces:
```ts
export interface StoredItem {
  id: number; urlCanonical: string; contentHash: string; sourceKind: string; sourceName: string;
  title: string; summary: string; signal: Signal | null; importance: number | null;
  facts: Record<string, unknown> | null; publishedAt: string; fetchedAt: string;
  entities: string[]; domains: Domain[]; urls: string[]; flagged: boolean;
}
export interface NewItem { urlCanonical: string; contentHash: string; sourceKind: string; sourceName: string;
  title: string; summary: string; signal: Signal | null; importance: number | null;
  facts?: Record<string, unknown> | null; publishedAt: string; fetchedAt: string;
  entities: string[]; domains: Domain[]; flagged?: boolean }
export interface FeedState { feedId: string; lastSeenAt: string | null; lastItemHash: string | null; consecutiveFailures: number }
export interface WatchlistStore {
  insertItem(item: NewItem): number;                        // returns the item id
  findByHash(contentHash: string): StoredItem | null;
  findByUrl(urlCanonical: string): StoredItem | null;
  addSource(itemId: number, sourceKind: string, url: string): void;
  itemsInPeriod(from: string, to: string, options?: { entities?: string[]; domains?: Domain[] }): StoredItem[];
  countsByEntity(from: string, to: string): Array<{ entityId: string; items: number; maxImportance: number }>;
  getFeedState(feedId: string): FeedState;
  recordFeedSuccess(feedId: string, lastSeenAt: string, lastItemHash: string): void;
  recordFeedFailure(feedId: string): number;                 // returns consecutiveFailures after increment
  startRun(startedAt: string): number;
  finishRun(runId: number, finishedAt: string, stats: { fetched: number; deduped: number; tagged: number; failedFeeds: number }): void;
  lastRun(): { id: number; startedAt: string; finishedAt: string | null; fetched: number; deduped: number; tagged: number; failedFeeds: number } | null;
  close(): void;
}
export function openWatchlistStore(path?: string): WatchlistStore;   // default data/watchlist.db
```
  Pattern follows `src/services/feedback-store.ts` (WAL, `CREATE TABLE IF NOT EXISTS`). Tests pass `:memory:` or a temp path — never the default.

- [ ] **Step 1: Write the failing test.** `__tests__/watchlist-store.test.ts` opens `openWatchlistStore(":memory:")` in `beforeEach`, defines a `base` NewItem the tests spread and override (`{ urlCanonical: "https://a/0", contentHash: "h0", sourceKind: "rss", sourceName: "f", title: "t", summary: "s", signal: "it_move", importance: 3, publishedAt: "2026-09-12T00:00:00.000Z", fetchedAt: "2026-09-12T01:00:00.000Z", entities: ["roche"], domains: ["cloud"] }`), and covers:

```ts
  it("stores an item with its entities, domains and sources, and reads it back", () => {
    const id = store.insertItem({ urlCanonical: "https://a/1", contentHash: "h1", sourceKind: "rss", sourceName: "Roche IR",
      title: "Roche picks a cloud", summary: "s", signal: "it_move", importance: 4,
      publishedAt: "2026-09-18T00:00:00.000Z", fetchedAt: "2026-09-19T00:00:00.000Z",
      entities: ["roche", "aws"], domains: ["cloud"] });
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

  it("rejects an unknown domain or signal at the storage boundary", () => {
    expect(() => store.insertItem({ /* …, domains: ["teleportation"] as unknown as Domain[] */ })).toThrow();
  });
```

- [ ] **Step 2: Run it and check that it fails.** `CI=true npm run test -- __tests__/watchlist-store.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement the schema and repository.** Tables per the spec (`items`, `item_entities`, `item_domains`, `item_sources`, `feed_state`, `runs`), `journal_mode = WAL`, indexes on `items.published_at`, `items.content_hash` (unique), `items.url_canonical` (unique), `item_entities.entity_id`. `insertItem` runs in a transaction and validates domains/signal against the closed sets before writing. `addSource` is idempotent (`INSERT OR IGNORE`).

- [ ] **Step 4: Run the tests and typecheck.** `CI=true npm run test -- __tests__/watchlist-store.test.ts && npm run typecheck && npm run typecheck:tests`. Expected: PASS. Confirm no `data/watchlist.db` was created by the run: `test ! -e data/watchlist.db && echo clean`.

- [ ] **Step 5: Commit.**

```bash
git add src/services/watchlist-store.ts __tests__/watchlist-store.test.ts
git commit -m "feat: add the watchlist item store"
```

---

### Task 3: Feed discovery and verification

**Files:**
- Create: `scripts/watchlist.ts` (first subcommand: `verify-feeds`)
- Modify: `config/watchlist.yaml` (fill in discovered feeds)
- Modify: `package.json` (`"watchlist": "tsx scripts/watchlist.ts"`)
- Test: `__tests__/watchlist-verify.test.ts`

**Interfaces:**
- Consumes: `loadWatchlist`, `Feed` (Task 1).
- Produces: `export async function verifyFeed(feed: Feed, fetchImpl?: FetchLike): Promise<{ ok: boolean; items: number; newest?: string; error?: string }>` exported from `src/services/watchlist-sources.ts` (created here, extended in Task 4).

This task has a research half and a code half. The code half is testable; the research half is verified by running the code.

- [ ] **Step 1: Write the failing test** for `verifyFeed` with an injected fetch: a valid RSS body returns `{ ok: true, items: 2, newest: <ISO> }`; a 404 returns `{ ok: false, error: "HTTP 404" }`; a body that is not XML returns `{ ok: false }`; a feed with no dated items returns `{ ok: false, error: /no dated items/ }`. Include one real-world quirk: an Atom feed using `<updated>` rather than `<pubDate>` must parse.

- [ ] **Step 2: Run it and check that it fails.** `CI=true npm run test -- __tests__/watchlist-verify.test.ts`.

- [ ] **Step 3: Implement `verifyFeed`** plus a minimal RSS/Atom parser in `watchlist-sources.ts` (no new dependency: a small regex/DOM-free extractor over `<item>`/`<entry>` is enough, and it is the same parser the `rss` adapter uses in Task 4). Then `scripts/watchlist.ts verify-feeds` loads the config, verifies every feed with a 10 s timeout and 2 concurrent requests, and prints one line per feed: `ok <entity> <kind> <items> newest=<date>` or `FAIL <entity> <kind> <error>`.

- [ ] **Step 4: Research the feeds.** For every entity in `config/watchlist.yaml`, find:
  - an RSS/Atom feed on its newsroom or IR page (search the site for `rss`, `feed.xml`, `atom.xml`, or a `<link rel="alternate" type="application/rss+xml">` tag);
  - for US filers, the CIK from EDGAR's company search (`https://www.sec.gov/cgi-bin/browse-edgar?company=<name>&action=getcompany`);
  - the IR results page URL where the company publishes results material.

  Add what you find under each entity's `feeds:`. Anything you cannot find goes in as a commented `# unverified: <what you looked for>` line rather than a guess. **A feed only enters the config after `verify-feeds` passes it**, with `verifiedAt: <today>` recorded beside it.

- [ ] **Step 5: Run the verifier against the real config.** `npm run watchlist verify-feeds`. Expected: every listed feed prints `ok`. Paste the output into the task report; list the entities left without a feed.

- [ ] **Step 6: Commit.**

```bash
git add config/watchlist.yaml scripts/watchlist.ts src/services/watchlist-sources.ts __tests__/watchlist-verify.test.ts package.json
git commit -m "feat: verify watchlist feeds and record the discovered ones"
```

---

### Task 4: RSS and news adapters

**Files:**
- Modify: `src/services/watchlist-sources.ts`
- Test: `__tests__/watchlist-sources.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RawItem { title: string; url: string; publishedAt: string; body: string; sourceKind: Feed["kind"]; sourceName: string }
export interface FetchLike { (url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; text(): Promise<string> }> }
export interface AdapterDeps { fetchImpl: FetchLike; now(): Date; userAgent: string }
export function rssAdapter(deps: AdapterDeps): (feed: Feed, entity: Entity, since: string | null) => Promise<RawItem[]>;
export function newsAdapter(deps: AdapterDeps): (query: string, since: string | null) => Promise<RawItem[]>;
export function canonicalUrl(url: string): string;      // strips utm_*, fbclid, gclid, trailing slash, fragment; lowercases host
export function contentHash(title: string, body: string): string;  // sha256 of normalised whitespace+lowercase
```

- [ ] **Step 1: Write the failing tests.** Cover with injected fetch and fixed clock:
  - `rssAdapter` parses an RSS 2.0 body into `RawItem[]` with ISO dates, and an Atom body likewise;
  - items older than `since` are dropped;
  - a non-200 response rejects with an error naming the status but not the URL's query string;
  - `newsAdapter` builds the Google News RSS URL for a query (same parameters as `src/services/web-search.ts`) and parses its results;
  - `canonicalUrl` strips `utm_source`/`utm_medium`/`fbclid`/fragment, keeps meaningful query params, lowercases the host, drops a trailing slash — the same input in two forms gives one string;
  - `contentHash` is stable across whitespace and case differences and differs for different text.

- [ ] **Step 2: Run them and check that they fail.**

- [ ] **Step 3: Implement.** Both adapters share the Task 3 parser. Every outbound request sends `deps.userAgent` and a 15 s timeout. `news` results carry `sourceKind: "news"` and `sourceName: "Google News"`; `rss` carries the entity's feed name.

- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/watchlist-sources.ts __tests__/watchlist-sources.test.ts
git commit -m "feat: add the rss and news watchlist adapters"
```

---

### Task 5: EDGAR and IR-page adapters

**Files:**
- Create: `src/services/watchlist-edgar.ts`
- Test: `__tests__/watchlist-edgar.test.ts`

**Interfaces:**
- Consumes: `RawItem`, `AdapterDeps`, `FetchLike` (Task 4).
- Produces:
```ts
export function edgarAdapter(deps: AdapterDeps): (cik: string, entity: Entity, since: string | null) => Promise<RawItem[]>;
export function irPageAdapter(deps: AdapterDeps): (url: string, entity: Entity, since: string | null) => Promise<RawItem[]>;
export function edgarSubmissionsUrl(cik: string): string;   // https://data.sec.gov/submissions/CIK##########.json
```

EDGAR facts: `https://data.sec.gov/submissions/CIK{10-digit zero-padded}.json` returns `filings.recent` with parallel arrays (`form`, `filingDate`, `accessionNumber`, `primaryDocument`, `reportDate`). A filing's URL is `https://www.sec.gov/Archives/edgar/data/{cik-no-zeros}/{accession-no-dashes}/{primaryDocument}`. The API requires a declared `User-Agent` and rate-limits at 10 requests/second.

- [ ] **Step 1: Write the failing tests** with an injected fetch returning a trimmed `submissions` fixture:
  - only forms of interest are kept (`8-K`, `10-Q`, `10-K`, `6-K`, `20-F`), others dropped;
  - filings older than `since` are dropped;
  - the built URL matches the pattern above for a zero-padded CIK;
  - a 403 (EDGAR's response to a missing User-Agent) produces an error naming the status;
  - `edgarSubmissionsUrl("1114448")` pads to `CIK0001114448.json`;
  - `irPageAdapter` extracts dated links from a results page fixture, resolves relative hrefs against the page URL, and drops undated links.

- [ ] **Step 2: Run them and check that they fail.**

- [ ] **Step 3: Implement.** `edgarAdapter` fetches submissions, zips the parallel arrays, filters by form and date, and returns one `RawItem` per filing with the filing's title as `form + reportDate`. `irPageAdapter` fetches the page and extracts `<a>` elements with a nearby date, with a hard cap of 20 links per page. Both send the declared User-Agent.

- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/watchlist-edgar.ts __tests__/watchlist-edgar.test.ts
git commit -m "feat: add the edgar and ir-page watchlist adapters"
```

---

### Task 6: Tagger

**Files:**
- Create: `src/services/watchlist-tagger.ts`
- Test: `__tests__/watchlist-tagger.test.ts`

**Interfaces:**
- Consumes: `Watchlist`, `Domain`, `Signal` (Task 1), `RawItem` (Task 4).
- Produces:
```ts
export interface Tagging { summary: string; entities: string[]; domains: Domain[]; signal: Signal | null; importance: number | null; facts: Record<string, unknown> | null; flagged: boolean }
export interface TaggerDeps { chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>; watchlist: Watchlist }
export function buildTaggingPrompt(item: RawItem, watchlist: Watchlist, candidateIds: string[]): ChatMessage[];
export function parseTagging(raw: string, watchlist: Watchlist): Tagging | null;   // null when unparseable
export function createTagger(deps: TaggerDeps): (item: RawItem, candidateIds: string[]) => Promise<Tagging>;
```
  `candidateIds` narrows the vocabulary shown to the model to the entities whose names or aliases appear in the item plus the feed's own entity, so the prompt stays short.

- [ ] **Step 1: Write the failing tests** with a fake `chat`:
  - a well-formed JSON reply becomes a `Tagging`;
  - unknown entity ids and unknown domains are dropped, the rest kept;
  - an importance outside 1–5, or a non-integer, becomes `null` and sets `flagged`;
  - JSON wrapped in prose or a ```json fence is still parsed (the local model does this);
  - an unparseable reply makes `createTagger` retry once and then return a `flagged` tagging carrying the item's title as summary and no tags;
  - an item with no matching entity keeps its domains and returns `entities: []`;
  - the prompt lists only `candidateIds`, never the whole watchlist, and instructs strict JSON.

- [ ] **Step 2: Run them and check that they fail.**

- [ ] **Step 3: Implement.** The prompt states the closed vocabularies, the importance rubric (5 = a named customer's strategic IT/financial move; 1 = routine vendor noise), and demands a single JSON object. `parseTagging` extracts the first balanced `{...}` block, parses it, and validates each field against the closed sets with type guards.

- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/watchlist-tagger.ts __tests__/watchlist-tagger.test.ts
git commit -m "feat: tag watchlist items with a closed vocabulary"
```

---

### Task 7: Ingest orchestrator

**Files:**
- Create: `src/services/watchlist-ingest.ts`
- Test: `__tests__/watchlist-ingest.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
```ts
export interface IngestDeps {
  watchlist: Watchlist;
  store: WatchlistStore;
  adapters: {
    rss(feed: Feed, entity: Entity, since: string | null): Promise<RawItem[]>;
    news(query: string, since: string | null): Promise<RawItem[]>;
    edgar(cik: string, entity: Entity, since: string | null): Promise<RawItem[]>;
    irPage(url: string, entity: Entity, since: string | null): Promise<RawItem[]>;
  };
  tag(item: RawItem, candidateIds: string[]): Promise<Tagging>;
  embed(texts: string[], metadatas: Record<string, unknown>[]): Promise<number>;  // ChromaDB writer, injected
  now(): Date;
  limit: number;          // default 250
  log(line: string): void;
}
export interface IngestResult { fetched: number; deduped: number; tagged: number; stored: number; skippedByCap: number; failedFeeds: string[]; runId: number }
export function createIngestRun(deps: IngestDeps): (options?: { since?: string; only?: string[] }) => Promise<IngestResult>;
```

- [ ] **Step 1: Write the failing tests**, all with fake adapters, a fake tagger, an in-memory store and a fake embed:
  - items are fetched for every due feed and stored with their tagging;
  - the same article from two adapters is stored once, with both URLs recorded (`addSource`), and the tagger is called once;
  - an item already in the store from a previous run is skipped without a model call;
  - the cap stops work after `limit` items **in priority order**: with a cap of 2 and items from a customer, a peer and a vendor, the customer's and peer's are stored and the vendor's is counted in `skippedByCap`;
  - a feed that throws is recorded as a failure, does not abort the run, and appears in `failedFeeds`;
  - a feed's watermark advances only on success;
  - every stored item is also embedded once, with `entity`, `domain`, `signal` and `published_at` in the metadata;
  - the run is recorded via `startRun`/`finishRun`.

- [ ] **Step 2: Run them and check that they fail.**

- [ ] **Step 3: Implement.** Order feeds by `watchlist.priority`; for each, read `feed_state` for `since`; fetch; normalise; compute `canonicalUrl`/`contentHash`; dedupe within the batch and against the store; apply the cap; tag survivors sequentially (the local model serves one request at a time); write the row, the join rows and the ChromaDB embedding; advance the watermark. Any adapter error is caught per feed.

- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS. Also confirm nothing in the test run touched ChromaDB: `grep -rn "chromadb-store" __tests__/watchlist-*.test.ts` prints nothing.

- [ ] **Step 5: Commit.**

```bash
git add src/services/watchlist-ingest.ts __tests__/watchlist-ingest.test.ts
git commit -m "feat: orchestrate the nightly watchlist ingest"
```

---

### Task 8: CLI, schedule and the news-agent handover

**Files:**
- Modify: `scripts/watchlist.ts` (add `ingest`, `status`)
- Modify: `src/services/news-agent.ts` (read topics from the watchlist)
- Modify: `hermes/cron/jobs.json`, `README.md`
- Test: `__tests__/watchlist-cli.test.ts`, existing `__tests__/news-agent*.test.ts` if present

- [ ] **Step 1: Write the failing tests.** `watchlist status` prints counts per entity for a window from an injected store (no live DB). `getAgentTopics()` returns the topic strings from `config/watchlist.yaml` rather than the in-file constant, and every string previously in `SEARCH_TOPICS` is still returned (pin the count and a sample).

- [ ] **Step 2: Run them and check that they fail.**

- [ ] **Step 3: Implement.** `scripts/watchlist.ts ingest [--limit N] [--since ISO] [--only id,id]` wires the real config, store, adapters, tagger (`getLlmClient().chat`) and ChromaDB writer (`addToChromaDB`), prints the `IngestResult` and exits non-zero if every feed failed. `status [--days N]` prints per-entity counts. `news-agent.ts` takes its topic list from the watchlist, keeping its own behaviour otherwise.

- [ ] **Step 4: Schedule it.** Add a Hermes cron job to `hermes/cron/jobs.json` at **02:30 daily** (clear of the 06:00/07:00/09:00 jobs), script mode, running `scripts/watchlist.ts ingest`, delivering only on failure. Document in `README.md`: what the watchlist is, the config file, the CLI commands, the schedule, and that Phase 2 (digests) is not built yet.

- [ ] **Step 5: Run everything.** `CI=true npm run test && npm run typecheck && npm run typecheck:tests`. Expected: all green.

- [ ] **Step 6: Commit.**

```bash
git add scripts/watchlist.ts src/services/news-agent.ts hermes/cron/jobs.json README.md __tests__/watchlist-cli.test.ts
git commit -m "feat: run the watchlist ingest nightly and share its topics with the news agent"
```

---

### Task 9: First live run (with the owner)

This task touches the live machine and the internet. **Ask the owner before each step.**

- [ ] **Step 1: Dry run against real feeds, small.** `npm run watchlist ingest -- --limit 10 --only roche`. Expected: items fetched, tagged and stored; no ChromaDB errors. Inspect: `sqlite3 data/watchlist.db "select entity_id, count(*) from item_entities group by 1"`.
- [ ] **Step 2: Read ten tagged items by hand** (`npm run watchlist status --days 7`, then a couple of rows in full) and judge the tagging: right entity, sane domain, sensible importance. Record the hit rate in the report; if it is poor, that is a Task 6 prompt fix, not a Phase 2 problem.
- [ ] **Step 3: Full backfill.** `npm run watchlist ingest -- --since <30 days ago>`, watching the clock and the cap. Record wall-clock time and items stored — this number decides whether the nightly cap is right.
- [ ] **Step 4: Verify Q&A improved.** Ask the chat UI a question that only the new data answers (e.g. a recent Roche IT move) and confirm the answer cites a stored item.
- [ ] **Step 5: Install the cron job** (`scripts/hermes-setup.sh install-cron`) and confirm with `hermes cron list` that the 02:30 job exists.
- [ ] **Step 6: Record the results** in `docs/superpowers/plans/2026-09-20-watchlist-phase-1-verification.md` and commit.

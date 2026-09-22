// Binds the export pipeline to real services. Kept separate from
// src/api/export.ts so every unit above this module stays injectable and no
// test ever reaches a live service: this is the one place that opens the
// real job database, writes real files, and (once Task 12 lands) sends a
// real Telegram document.
import neo4j from "neo4j-driver";
import type { Driver } from "neo4j-driver";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatherDeps } from "./export-artifacts.js";
import { gather } from "./export-artifacts.js";
import { deliver } from "./export-delivery.js";
import { openExportJobs } from "./export-jobs.js";
import { narrateArtifact } from "./export-narrative.js";
import type { PipelineDeps } from "./export-pipeline.js";
import { getDriver } from "./graph-store.js";
import { getLlmClient } from "./llm-client.js";
import type { LlmClient, StatsCollector } from "./llm-client.js";
import { renderPdf } from "./render-pdf.js";
import { renderPptx } from "./render-pptx.js";
import { renderXlsx } from "./render-xlsx.js";
import { openWatchlistStore } from "./watchlist-store.js";
import type { WatchlistStore } from "./watchlist-store.js";

// The minimal shape buildGatherDeps needs: a way to run a read-only Cypher
// query and a way to fetch an entity's recent watchlist items. Kept
// separate from any concrete driver/store type so the unit tests below can
// pass plain fakes without touching Neo4j or sqlite.
export interface GraphReader {
  runCypher(query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  itemsFor(entity: string, limit: number): Array<{ title: string; url: string; publishedAt: string }>;
}

const INCUMBENCY_CYPHER = `
  MATCH (a:Account)-[u:USES]->(v:Vendor)
  RETURN a.id AS account, u.segment AS segment, collect(v.id) AS vendors
  ORDER BY account, segment
`;

const POSITIONS_CYPHER = `
  MATCH (v:Vendor {id: $vendor})-[c:COMPETES_IN]->(s:Segment)
  RETURN s.id AS segment, c.position AS position, c.confidence AS confidence, c.rationale AS rationale
  ORDER BY segment
`;

// R3 (fix round 1, finding 2): a Neo4j row is Record<string, unknown> --
// nothing about the graph schema stops a property from being absent or
// null. String(undefined) === "undefined" and String(null) === "null", so
// the bare String(r.field) this replaced did not fail on a malformed row --
// it printed the literal word "undefined"/"null" straight into an artifact
// that may be handed to a customer. Every required field is now checked
// with a real type guard (no `any`) before being trusted.
//
// Chosen remedy: THROW on a malformed row, not skip it. export-artifacts.ts
// already set this project's rule for a required value via requireOption():
// "fail loudly... rather than falling back to ... quietly produc[ing] a thin
// or wrong artifact." A row with a missing/null required field is at least
// as serious as a missing CLI option -- it means the graph itself holds an
// inconsistent node or relationship -- and silently skipping it would hand a
// customer an incumbency or competitive-position table with fewer rows than
// the graph actually has, with no signal anywhere that a row was dropped.
// export-pipeline.ts's runExport already wraps gather() in a try/catch that
// records a clear failure message on the job, so throwing here turns a bad
// row into a visible, retryable export failure instead of an invisible gap
// in a deliverable -- consistent with finding 2's own framing ("this
// subsystem must not produce quietly").
// Describes a rejected value for the error message without ever printing
// the bare words "undefined"/"null" that this fix exists to keep out of an
// artifact -- a diagnostic message naming what went wrong is not the same
// thing as those words leaking into the row data itself, but there is no
// reason to risk the confusion when a clearer label is just as easy.
function describeValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (value === null) return "<null>";
  return JSON.stringify(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`export-wiring: row is missing required field "${field}" (got ${describeValue(value)})`);
  }
  return value;
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`export-wiring: row is missing required field "${field}" (got ${describeValue(value)})`);
  }
  return value.map((entry, i) => requiredString(entry, `${field}[${i}]`));
}

export function buildGatherDeps(reader: GraphReader): GatherDeps {
  return {
    async incumbency() {
      const rows = await reader.runCypher(INCUMBENCY_CYPHER);
      return rows.map((r) => ({
        account: requiredString(r.account, "account"),
        segment: requiredString(r.segment, "segment"),
        vendors: requiredStringArray(r.vendors, "vendors"),
      }));
    },
    async positions(vendor) {
      const rows = await reader.runCypher(POSITIONS_CYPHER, { vendor });
      return rows.map((r) => ({
        segment: requiredString(r.segment, "segment"),
        position: requiredString(r.position, "position"),
        confidence: requiredString(r.confidence, "confidence"),
        // rationale is the one genuinely optional field here -- an
        // un-rationalised position is still a valid position -- so any
        // non-string value (missing, null, or otherwise) falls back to ""
        // instead of taking the rejection path above.
        rationale: typeof r.rationale === "string" ? r.rationale : "",
      }));
    },
    async news(entity, limit) {
      return reader.itemsFor(entity, limit);
    },
  };
}

// R1 (controller ruling 1): the brief's liveReader() opened a second
// neo4j.driver(...) with its own copy of the NEO4J_PASSWORD fallback.
// graph-store.ts's getDriver() already holds that exact credential triple
// behind a lazily-memoised singleton, and closeNeo4j() already owns
// shutting it down; opening a second driver here would be a second
// unclosed connection pool and a sixth hardcoded password constant. Reuse
// the one entry point instead of constructing our own.
//
// R2 (controller ruling 2): the brief opened a fresh WatchlistStore (a
// sqlite connection) inside itemsFor() on every call, and filtered
// entities in JavaScript after fetching the widest possible period. The
// pipeline calls news() once per artifact section, so a naive per-call open
// would open/close a sqlite handle several times per export. Instead the
// store is opened once, when the reader is built, reused for every
// itemsFor() call, and closed via close() once the reader itself is done.
// The entity filter is pushed into itemsInPeriod's own `entities` option
// (WatchlistStore already supports it) rather than re-implemented in JS.
// This is a cleanliness fix, not a measured performance win: the live
// store is ~760 items / ~241 KB, nowhere near large enough for the
// per-call cost to matter.
export interface LiveGraphReader extends GraphReader {
  close(): void;
}

// R4 (fix round 1, finding 1): liveReader() used to call getDriver() and
// openWatchlistStore() on every invocation. buildPipelineDeps() runs once
// per POST /api/export (src/api/export.ts's runPipeline), so every export
// opened a fresh WAL-mode sqlite handle -- three file descriptors (.db,
// .db-wal, .db-shm) -- and nothing ever closed it, for the life of the
// server process. getDriver() already avoids the equivalent problem on the
// Neo4j side with a lazy module-scope memo (`if (!driver) driver = ...`);
// cachedReader mirrors that shape for the reader as a whole, so the
// watchlist store (and the driver-session-bearing reader wrapping it) is
// opened at most once per process.
//
// The memo is populated on FIRST USE only, via `??=` inside liveReader()
// itself -- never `const cachedReader = buildLiveReader(...)` at module
// scope. Task 9 removed exactly that kind of import-time side effect from
// this file (importing it used to open a real database as a side effect,
// and the green test suite did not notice -- it was caught by `git
// status`). A module-scope initializer would reintroduce it: merely
// importing export-wiring.ts would open a real sqlite file again.
let cachedReader: LiveGraphReader | null = null;

// getDriver/openStore are injectable (defaulting to the real
// implementations) so a test can observe -- or fully fake -- how the reader
// is built without ever touching a live Neo4j server or a real watchlist
// database. Production code (buildPipelineDeps below) always calls
// liveReader() with no argument.
export function liveReader(deps: { getDriver?: () => Driver; openStore?: () => WatchlistStore } = {}): LiveGraphReader {
  return (cachedReader ??= buildLiveReader(deps.getDriver ?? getDriver, deps.openStore ?? openWatchlistStore));
}

function buildLiveReader(getDriverFn: () => Driver, openStore: () => WatchlistStore): LiveGraphReader {
  const driver = getDriverFn();
  const store = openStore();
  return {
    async runCypher(query, params = {}) {
      // READ access mode: this reader is only ever used to gather data for
      // an export, never to write the graph.
      const session = driver.session({ defaultAccessMode: neo4j.session.READ });
      try {
        const result = await session.run(query, params);
        return result.records.map((r) => r.toObject() as Record<string, unknown>);
      } finally {
        await session.close();
      }
    },
    itemsFor(entity, limit) {
      return store
        .itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: [entity] })
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, limit)
        .map((item) => ({ title: item.title, url: item.urlCanonical, publishedAt: item.publishedAt.slice(0, 10) }));
    },
    close() {
      store.close();
    },
  };
}

// R5: narrateArtifact's `chat` seam is `(prompt: string) => Promise<string>`
// (Task 11 brief) -- a signature that has no room to say "the model was cut
// off". llm-client.ts's TokenStats.truncated exists for exactly this
// problem on the chat UI's streaming path (comment at its declaration: "a
// turn that spent its whole budget was previously indistinguishable from one
// that had nothing to say"); narration has the same failure mode but a worse
// consequence -- prose written into a document nobody watches get produced,
// so a half sentence would ship as finished work instead of rendering as an
// obviously-broken reply.
//
// Two ways to surface it were on the table:
//   (a) change narrateArtifact's `chat` type to return more than a string
//       (e.g. {text, truncated}), or
//   (b) keep the signature exactly as specified and have the concrete `chat`
//       implementation REJECT instead of resolve when truncated.
// (b) wins: it needs no change to narrateArtifact or its already-approved
// signature, and it reuses a mechanism this codebase already relies on --
// export-pipeline.ts's runExport wraps deps.narrate(...) in a try/catch that
// records whatever stage was active (here, "narrating") plus the thrown
// message on the job. A truncated narration becomes a normal, attributable
// job failure through the exact same path a gatherer or renderer error
// already takes, rather than a second, bespoke failure channel.
//
// This is also why streamChat (not the plain chat()) is used below: chat()
// (line ~253) reads only `choices[0].message.content` and drops
// finish_reason entirely, so truncation is invisible to it. Only the
// streaming path threads a StatsCollector through to `truncated`.
export function buildNarrationChat(llm: Pick<LlmClient, "streamChat">): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const stats: StatsCollector = {};
    let body = "";
    for await (const token of llm.streamChat([{ role: "user", content: prompt }], {}, stats)) {
      body += token;
    }
    if (stats.result?.truncated) {
      throw new Error("narration truncated: model hit its token limit before finishing");
    }
    return body;
  };
}

export async function buildPipelineDeps(): Promise<PipelineDeps> {
  return {
    // Note: openExportJobs() above is opened fresh on every call to
    // buildPipelineDeps() (one per export job -- see src/api/export.ts's
    // runPipeline) and is not closed here: PipelineDeps has no teardown
    // hook, so there is no place in this function to call it once the job
    // finishes. liveReader() below is different: it is memoised at module
    // scope (see cachedReader above), so repeated calls here return the same
    // reader and open the watchlist store at most once per process, the
    // same lifecycle openExportJobs() itself gets from src/api/export.ts's
    // own module-scope memo. liveReader()'s close() exists for callers
    // (tests, or a future lifecycle hook) that do manage that scope
    // explicitly.
    jobs: openExportJobs(),
    gather,
    gatherDeps: buildGatherDeps(liveReader()),
    // narrateArtifact (Task 11) writes the "Summary" prose section from the
    // artifact's own facts, using the shared LlmClient through
    // buildNarrationChat above so a truncated turn fails the job instead of
    // shipping a half sentence.
    async narrate(artifact) {
      return narrateArtifact(artifact, buildNarrationChat(getLlmClient()));
    },
    render: { xlsx: renderXlsx, pdf: renderPdf, pptx: renderPptx },
    deliver,
    deliveryDeps: {
      downloadDir: join(process.cwd(), "data", "exports"),
      icloudDir: join(homedir(), "Documents", "PharmaITChat_Artifacts"),
      async writeFile(path, bytes) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      },
      async sendDocument() {
        throw new Error("telegram delivery is wired in Task 12");
      },
    },
  };
}

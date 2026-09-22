// Binds the export pipeline to real services. Kept separate from
// src/api/export.ts so every unit above this module stays injectable and no
// test ever reaches a live service: this is the one place that opens the
// real job database, writes real files, and (once Task 12 lands) sends a
// real Telegram document.
import neo4j from "neo4j-driver";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatherDeps } from "./export-artifacts.js";
import { gather } from "./export-artifacts.js";
import { deliver } from "./export-delivery.js";
import { openExportJobs } from "./export-jobs.js";
import type { PipelineDeps } from "./export-pipeline.js";
import { getDriver } from "./graph-store.js";
import { renderPdf } from "./render-pdf.js";
import { renderPptx } from "./render-pptx.js";
import { renderXlsx } from "./render-xlsx.js";
import { openWatchlistStore } from "./watchlist-store.js";

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

export function buildGatherDeps(reader: GraphReader): GatherDeps {
  return {
    async incumbency() {
      const rows = await reader.runCypher(INCUMBENCY_CYPHER);
      return rows.map((r) => ({
        account: String(r.account),
        segment: String(r.segment),
        vendors: Array.isArray(r.vendors) ? r.vendors.map(String) : [],
      }));
    },
    async positions(vendor) {
      const rows = await reader.runCypher(POSITIONS_CYPHER, { vendor });
      return rows.map((r) => ({
        segment: String(r.segment),
        position: String(r.position),
        confidence: String(r.confidence),
        rationale: String(r.rationale ?? ""),
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

function liveReader(): LiveGraphReader {
  const driver = getDriver();
  const store = openWatchlistStore();
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

export async function buildPipelineDeps(): Promise<PipelineDeps> {
  return {
    // Note: openExportJobs() above and liveReader()'s watchlist store below
    // are both opened fresh on every call to buildPipelineDeps() (one per
    // export job -- see src/api/export.ts's runPipeline) and neither is
    // closed here: PipelineDeps has no teardown hook, so there is no place
    // in this function to call it once the job finishes. This matches the
    // existing jobs store's lifecycle rather than diverging from it.
    // liveReader()'s close() exists for callers (tests, or a future
    // lifecycle hook) that do manage that scope explicitly.
    jobs: openExportJobs(),
    gather,
    gatherDeps: buildGatherDeps(liveReader()),
    // Narration is added in Task 11; until then the artifact passes through
    // unchanged, so the pipeline is end-to-end testable without the model.
    async narrate(artifact) {
      return artifact;
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

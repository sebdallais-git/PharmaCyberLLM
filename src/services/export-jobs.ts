// Export job store.
//
// Persists the async export pipeline's state. `stage` is a RESUME POINT, not
// a progress label: narration runs at roughly 3.4 tok/s on a single local
// model server, so an export never completes synchronously, and a job must
// be resumable from wherever it left off. Gathered facts are checkpointed
// before narration so a retry re-narrates without re-gathering; a rendered
// file is checkpointed before delivery so a delivery failure re-delivers
// without re-rendering. Task 8's pipeline drives the stage transitions --
// this store only has to make sure each transition is durable and that no
// unknown value ever reaches a row.
//
// Follows the same better-sqlite3 pattern as watchlist-store.ts: WAL journal
// mode, CREATE TABLE IF NOT EXISTS, prepared statements, a store object
// returned from an open function.
//
// R1: `stage`, `kind`, `format`, `audience` and `destination` are all closed
// vocabularies. An unknown value in any of them must never reach a row --
// validated at the storage boundary (create/setStage/fail), the same place
// watchlist-store.ts's insertItem validates domains and signals. `kind` and
// `destination` reuse the guards already declared for those vocabularies
// (isArtifactKind, isDestination) rather than re-declaring them; `audience`
// reuses isAudience from artifact.ts for the same reason. `stage` and
// `format` have no existing guard elsewhere, so this module is their
// canonical home and declares both.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAudience, type Audience } from "./artifact.js";
import { isArtifactKind, type ArtifactKind } from "./export-artifacts.js";
import { isDestination, type Destination } from "./export-delivery.js";

export const EXPORT_FORMATS = ["xlsx", "pdf", "pptx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

export const STAGES = ["queued", "gathering", "narrating", "rendering", "delivering", "done", "failed"] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

export interface ExportRequest {
  kind: ArtifactKind;
  format: ExportFormat;
  audience: Audience;
  destination: Destination;
  account?: string;
  vendor?: string;
}

export interface ExportJob extends ExportRequest {
  id: string;
  stage: Stage;
  location: string | null;
  error: string | null;
  createdAt: string;
}

export interface ExportJobStore {
  create(request: ExportRequest): string;
  get(id: string): ExportJob | null;
  setStage(id: string, stage: Stage): void;
  complete(id: string, location: string): void;
  fail(id: string, stage: Stage, message: string): void;
  close(): void;
}

// Raw row shape as better-sqlite3 hands it back (snake_case columns).
interface JobRow {
  id: string;
  kind: string;
  format: string;
  audience: string;
  destination: string;
  account: string | null;
  vendor: string | null;
  stage: string;
  location: string | null;
  error: string | null;
  created_at: string;
}

export function openExportJobs(path: string = join(process.cwd(), "data", "export-jobs.db")): ExportJobStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS export_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      format TEXT NOT NULL,
      audience TEXT NOT NULL,
      destination TEXT NOT NULL,
      account TEXT,
      vendor TEXT,
      stage TEXT NOT NULL,
      location TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // ---- prepared statements -------------------------------------------------

  const insertStmt = db.prepare(`
    INSERT INTO export_jobs (id, kind, format, audience, destination, account, vendor, stage, location, error, created_at)
    VALUES (@id, @kind, @format, @audience, @destination, @account, @vendor, 'queued', NULL, NULL, @createdAt)
  `);
  const selectStmt = db.prepare(`SELECT * FROM export_jobs WHERE id = ?`);
  const setStageStmt = db.prepare(`UPDATE export_jobs SET stage = ? WHERE id = ?`);
  const completeStmt = db.prepare(`UPDATE export_jobs SET stage = 'done', location = ? WHERE id = ?`);
  const failStmt = db.prepare(`UPDATE export_jobs SET stage = 'failed', error = ? WHERE id = ?`);

  // ---- validation -----------------------------------------------------------
  // Mirrors watchlist-store.ts's assertKnownDomains/assertKnownSignal: throw
  // before any statement runs, so an invalid value never reaches a row.

  function assertKnownRequest(request: ExportRequest): void {
    if (!isArtifactKind(request.kind)) {
      throw new Error(`unknown kind "${request.kind}"`);
    }
    if (!isExportFormat(request.format)) {
      throw new Error(`unknown format "${request.format}"`);
    }
    if (!isAudience(request.audience)) {
      throw new Error(`unknown audience "${request.audience}"`);
    }
    if (!isDestination(request.destination)) {
      throw new Error(`unknown destination "${request.destination}"`);
    }
  }

  function assertKnownStage(stage: Stage): void {
    if (!isStage(stage)) {
      throw new Error(`unknown stage "${stage}"`);
    }
  }

  // ---- row -> domain object mapping ----------------------------------------

  function hydrateJob(row: JobRow): ExportJob {
    return {
      id: row.id,
      kind: row.kind as ArtifactKind,
      format: row.format as ExportFormat,
      audience: row.audience as Audience,
      destination: row.destination as Destination,
      account: row.account ?? undefined,
      vendor: row.vendor ?? undefined,
      stage: row.stage as Stage,
      location: row.location,
      error: row.error,
      createdAt: row.created_at,
    };
  }

  return {
    create(request: ExportRequest): string {
      assertKnownRequest(request);

      const id = randomUUID();
      insertStmt.run({
        id,
        kind: request.kind,
        format: request.format,
        audience: request.audience,
        destination: request.destination,
        account: request.account ?? null,
        vendor: request.vendor ?? null,
        createdAt: new Date().toISOString(),
      });
      return id;
    },

    get(id: string): ExportJob | null {
      const row = selectStmt.get(id) as JobRow | undefined;
      return row === undefined ? null : hydrateJob(row);
    },

    setStage(id: string, stage: Stage): void {
      assertKnownStage(stage);
      setStageStmt.run(stage, id);
    },

    complete(id: string, location: string): void {
      completeStmt.run(location, id);
    },

    fail(id: string, stage: Stage, message: string): void {
      assertKnownStage(stage);
      failStmt.run(`${stage}: ${message}`, id);
    },

    close(): void {
      db.close();
    },
  };
}

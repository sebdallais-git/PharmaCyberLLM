// HTTP surface for artifact export: request one, poll its status, download
// the finished file.
//
// POST /api/export             -> { jobId }          (returns immediately)
// GET  /api/export/:id         -> job status          (poll for the location)
// GET  /api/export/file/:name  -> the file             (download destination)
//
// Every route here is asynchronous end to end: narration runs at roughly
// 3.4 tok/s behind a single local model server, so a deck can take minutes
// to render. POST must not await the pipeline -- it creates the job,
// launches the pipeline detached, and returns the job id. A "download"
// destination becomes a URL the caller polls for, never a held connection;
// a synchronous export would reproduce a timeout bug that previously made
// chat look broken.
//
// This file does NOT add /api/export to src/api/auth.ts's BROWSER_ROUTES.
// That list is an allowlist of UNPROTECTED routes ("these stay open"); an
// export carries the account intelligence config/accounts.local.yaml is
// gitignored to protect, so it must stay behind the API token like every
// other non-browser /api/* route. Absence from the list already means
// protected -- see __tests__/auth.test.ts for the pinning test.
//
// Router construction follows src/api/stack.ts: createExportRouter(deps)
// takes every collaborator as an argument, so a test can inject an
// in-memory job store and a fake pipeline runner. The default export wires
// the real ones; no test in this file opens the real job database or starts
// the real pipeline.
import { Router } from "express";
import type { Request, Response } from "express";
import { createReadStream, existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { isAudience } from "../services/artifact.js";
import { isArtifactKind } from "../services/export-artifacts.js";
import { isDestination } from "../services/export-delivery.js";
import { isExportFormat, openExportJobs } from "../services/export-jobs.js";
import type { ExportJobStore, ExportRequest } from "../services/export-jobs.js";
import { runExport } from "../services/export-pipeline.js";
import type { PipelineDeps } from "../services/export-pipeline.js";
import { buildPipelineDeps } from "../services/export-wiring.js";

export type ValidationResult = { ok: true; value: ExportRequest } | { ok: false; error: string };

// The body is attacker-controlled shape (this is a trust boundary): every
// field is checked with the same closed-set guard its storage layer uses,
// rather than re-declaring the vocabulary here or trusting a field's type.
export function validateExportRequest(body: unknown): ValidationResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  if (!isArtifactKind(b.kind)) {
    return { ok: false, error: `unknown artifact kind ${JSON.stringify(b.kind)}` };
  }
  if (!isExportFormat(b.format)) {
    return { ok: false, error: `unknown format ${JSON.stringify(b.format)} (expected xlsx, pdf or pptx)` };
  }
  // Deliberately no default: the two audiences contain different data, so a
  // missing audience must fail loudly rather than guess which one was meant.
  if (!isAudience(b.audience)) {
    return { ok: false, error: `audience is required and must be "internal" or "external"` };
  }
  const destination = b.destination ?? "download";
  if (!isDestination(destination)) {
    return { ok: false, error: `unknown destination ${JSON.stringify(destination)}` };
  }

  return {
    ok: true,
    value: {
      kind: b.kind,
      format: b.format,
      audience: b.audience,
      destination,
      account: typeof b.account === "string" ? b.account : undefined,
      vendor: typeof b.vendor === "string" ? b.vendor : undefined,
    },
  };
}

export interface ExportRouterDeps {
  jobs: ExportJobStore;
  downloadDir: string;
  // Kicks off the pipeline without the caller waiting on it. Fire-and-forget
  // by design: the route function returns before this settles.
  runPipeline(jobId: string): void;
}

// Mirrors export-delivery.ts's resolveDestinationPath: this is the read-side
// half of the same containment check the write side already applies.
// filename.replace(/[^a-z0-9._-]/gi, "") is NOT enough on its own -- dots
// are inside that allowed character class, so ".." survives the strip
// untouched and only an embedded "/" gets removed. Strip to a bare
// basename, resolve it against the download directory, and require the
// result to sit STRICTLY inside that directory (never equal to the
// directory itself, which is what a filename that sanitises down to "",
// ".", or ".." would otherwise resolve to). Returns null for anything that
// fails that check.
// Express's ParamsDictionary types a param as string | string[] to account
// for repeated wildcard segments; neither ":filename" nor ":id" here ever
// matches more than one segment, so this always narrows to a plain string
// at runtime. An array would only ever appear for a route pattern this file
// does not declare.
function singleParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function resolveDownloadPath(dir: string, filename: string): string | null {
  const safeName = basename(filename);
  const resolvedDir = resolve(dir);
  const resolvedPath = resolve(resolvedDir, safeName);
  return resolvedPath.startsWith(resolvedDir + sep) ? resolvedPath : null;
}

export function createExportRouter(deps: ExportRouterDeps): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response): void => {
    const result = validateExportRequest(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    const jobId = deps.jobs.create(result.value);
    // Not awaited: the caller polls GET /:id for progress and location.
    deps.runPipeline(jobId);

    res.status(202).json({ jobId });
  });

  // A malformed or unreachable filename is refused with 404, the same
  // status a filename that is well-formed but simply does not exist gets --
  // both mean "no such export is servable at that name" from the caller's
  // point of view, and neither should distinguish "you tried to escape the
  // directory" from "that file isn't there" to an unauthenticated-looking
  // path (this route still sits behind the API token, but the response
  // shape does not need to advertise which case happened).
  router.get("/file/:filename", (req: Request, res: Response): void => {
    const path = resolveDownloadPath(deps.downloadDir, singleParam(req.params.filename));
    if (path === null || !existsSync(path)) {
      res.status(404).json({ error: "no such export" });
      return;
    }
    createReadStream(path).pipe(res);
  });

  router.get("/:id", (req: Request, res: Response): void => {
    const job = deps.jobs.get(singleParam(req.params.id));
    if (job === null) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    res.json(job);
  });

  return router;
}

export interface PipelineRunnerDeps {
  jobs: ExportJobStore;
  buildPipelineDeps: () => Promise<PipelineDeps>;
  runExport: (id: string, deps: PipelineDeps) => Promise<void>;
}

// Wraps buildPipelineDeps() -> runExport() so a rejection that happens
// BEFORE runExport's own total try/catch (in practice: buildPipelineDeps()
// failing to reach Neo4j or the watchlist store) does not leave the job
// stranded at "queued" forever. runExport has its own error handling once
// it starts, so this only ever needs to record a failure for a job that
// never got that far -- "queued" is the honest stage to report, since
// gathering never began.
//
// Returns the underlying promise (rather than void) so tests can await it
// deterministically instead of guessing at a settle delay. Production
// wiring below discards the return value, which is fine: a function
// returning Promise<void> is assignable to ExportRouterDeps.runPipeline's
// "(jobId: string): void" precisely because a void-returning function type
// ignores whatever the assigned function returns.
//
// This function itself must never reject -- it is called fire-and-forget
// by the route handler, and a rejection here would become the unhandled
// rejection the original .catch() existed to avoid. jobs.fail() throws if
// the job id is unknown (export-jobs.ts); that should not happen here
// since create() already returned this id, but the inner try/catch guards
// against it regardless.
export function createPipelineRunner(deps: PipelineRunnerDeps): (jobId: string) => Promise<void> {
  return async (jobId: string): Promise<void> => {
    try {
      const pipelineDeps = await deps.buildPipelineDeps();
      await deps.runExport(jobId, pipelineDeps);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`export ${jobId}: pipeline wiring failed:`, message);
      try {
        deps.jobs.fail(jobId, "queued", `export could not be started: ${message}`);
      } catch (failErr: unknown) {
        console.error(
          `export ${jobId}: failed to record job failure:`,
          failErr instanceof Error ? failErr.message : failErr,
        );
      }
    }
  };
}

// openExportJobs() opens a real sqlite file (mkdirSync + a live connection) --
// real I/O, not just an object construction. Calling it at module load would
// mean simply IMPORTING this file (as every test that imports
// validateExportRequest or createExportRouter does, since ES modules
// execute the whole file) opens the real job database as a side effect.
// This lazily opens it on first actual use by a route handler instead, and
// memoizes the connection across requests -- the same shape as
// buildPipelineDeps(), which is itself only called once a request arrives.
function lazyJobStore(): ExportJobStore {
  let real: ExportJobStore | null = null;
  const ensure = (): ExportJobStore => (real ??= openExportJobs());
  return {
    create: (request) => ensure().create(request),
    get: (id) => ensure().get(id),
    setStage: (id, stage) => ensure().setStage(id, stage),
    complete: (id, location) => ensure().complete(id, location),
    fail: (id, stage, message) => ensure().fail(id, stage, message),
    close: () => real?.close(),
  };
}

const exportJobs = lazyJobStore();
const runPipeline = createPipelineRunner({ jobs: exportJobs, buildPipelineDeps, runExport });

export default createExportRouter({
  jobs: exportJobs,
  downloadDir: join(process.cwd(), "data", "exports"),
  // void: fire-and-forget, matching this route's comment above -- POST
  // must not await the pipeline. createPipelineRunner's returned promise
  // never rejects (see its own comment), so there is nothing to catch here.
  runPipeline: (jobId) => {
    void runPipeline(jobId);
  },
});

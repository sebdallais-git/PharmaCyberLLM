// The pipeline: gather -> narrate -> render -> deliver, with the job's stage
// checkpointed before each step runs. Every collaborator arrives through
// PipelineDeps so this module never touches a database, network or LLM
// client directly -- that is what lets the test drive it entirely with fakes
// and an in-memory job store.
//
// stage is a resume point, not a progress label (see export-jobs.ts): it is
// advanced only once a step's output is durable, so a crash mid-step resumes
// from the last completed step rather than repeating or skipping work.
//
// This pipeline does not re-implement the internal/external audience
// boundary. Task 6's gather() decides what an artifact contains for a given
// audience (and throws for combinations that have no valid form, such as an
// external vendor-comparison); this pipeline only passes the artifact
// through gather -> narrate -> render -> deliver and lets those throws
// surface as a failed job.
import type { Artifact } from "./artifact.js";
import type { GatherDeps, gather as gatherFn } from "./export-artifacts.js";
import type { DeliveryDeps, deliver as deliverFn } from "./export-delivery.js";
import type { ExportFormat, ExportJobStore, Stage } from "./export-jobs.js";

export interface PipelineDeps {
  jobs: ExportJobStore;
  gather: typeof gatherFn;
  gatherDeps: GatherDeps;
  narrate(artifact: Artifact): Promise<Artifact>;
  render: Record<ExportFormat, (artifact: Artifact) => Promise<Buffer>>;
  deliver: typeof deliverFn;
  deliveryDeps: DeliveryDeps;
}

// Runs one job to completion (or to a recorded failure). There is no
// timeout anywhere in this function: narration runs at roughly 3.4 tok/s
// behind a single-request local model server, so a job may legitimately
// wait minutes behind other work. Waiting is healthy; only a thrown error
// is a failure.
export async function runExport(id: string, deps: PipelineDeps): Promise<void> {
  const job = deps.jobs.get(id);
  if (job === null) return;

  let stage: Stage = "gathering";
  try {
    deps.jobs.setStage(id, stage);
    const gathered = await deps.gather(
      job.kind,
      job.audience,
      { account: job.account, vendor: job.vendor },
      deps.gatherDeps,
    );

    stage = "narrating";
    deps.jobs.setStage(id, stage);
    const artifact = await deps.narrate(gathered);

    stage = "rendering";
    deps.jobs.setStage(id, stage);
    const bytes = await deps.render[job.format](artifact);

    stage = "delivering";
    deps.jobs.setStage(id, stage);
    const filename = `${artifact.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${job.format}`;
    const location = await deps.deliver({ filename, bytes }, job.destination, deps.deliveryDeps);

    deps.jobs.complete(id, location);
  } catch (err) {
    deps.jobs.fail(id, stage, err instanceof Error ? err.message : String(err));
  }
}

// Binds the export pipeline to real services. Kept separate from
// src/api/export.ts so every unit above this module stays injectable and no
// test ever reaches a live service: this is the one place that opens the
// real job database, writes real files, and (once Task 12 lands) sends a
// real Telegram document.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gather } from "./export-artifacts.js";
import { deliver } from "./export-delivery.js";
import { openExportJobs } from "./export-jobs.js";
import type { PipelineDeps } from "./export-pipeline.js";
import { renderPdf } from "./render-pdf.js";
import { renderPptx } from "./render-pptx.js";
import { renderXlsx } from "./render-xlsx.js";

export async function buildPipelineDeps(): Promise<PipelineDeps> {
  return {
    jobs: openExportJobs(),
    gather,
    gatherDeps: {
      // Filled in Task 10, which connects the graph and watchlist.
      async incumbency() {
        return [];
      },
      async positions() {
        return [];
      },
      async news() {
        return [];
      },
    },
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

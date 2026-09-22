// Artifact export tools: request a document from PharmaITChat's data and
// poll the job it returns. Both routes on PharmaITChat's side return
// promptly (POST /api/export is fire-and-forget, GET /api/export/:id is a
// plain status read -- see src/api/export.ts), so neither tool needs the
// keepalive machinery runLongTool exists for; this follows graph.ts's
// shape (runTool only, no ToolOptions), not knowledge.ts's.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export function registerExportTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger): void {
  server.registerTool(
    "create_artifact",
    {
      description:
        "Produce a document from PharmaITChat's data: an account brief, incumbency matrix or vendor " +
        "comparison, as xlsx, pdf or pptx. `audience` is required -- 'internal' includes incumbency and " +
        "competitive position, 'external' omits them for something a customer may see. Returns a job id; " +
        "a deck takes several minutes. Poll with artifact_status.",
      inputSchema: {
        kind: z.enum(["account-brief", "incumbency-matrix", "vendor-comparison"]),
        format: z.enum(["xlsx", "pdf", "pptx"]),
        audience: z.enum(["internal", "external"]),
        destination: z.enum(["download", "telegram", "icloud"]).optional(),
        account: z.string().optional(),
        vendor: z.string().optional(),
      },
    },
    async (args) => runTool("create_artifact", log, () => client.post("/api/export", args))
  );

  server.registerTool(
    "artifact_status",
    {
      description: "Check an export job: its stage, and where the finished file went.",
      inputSchema: { job_id: z.string().min(1) },
    },
    // job_id becomes part of the request path; encodeURIComponent keeps a
    // value containing "/" or ".." from altering which route is actually
    // requested -- the same class of path-containment bug already fixed
    // twice on this branch, on export's write side (export-delivery.ts's
    // resolveDestinationPath) and read side (export.ts's resolveDownloadPath).
    async ({ job_id }) => runTool("artifact_status", log, () => client.get(`/api/export/${encodeURIComponent(job_id)}`))
  );
}

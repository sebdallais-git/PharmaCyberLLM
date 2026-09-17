// Feedback tools: rate answers and read feedback reports

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

const REPORT_ROUTES = {
  stats: "/api/feedback/stats",
  low_rated: "/api/feedback/low-rated",
  weekly_digest: "/api/feedback/weekly-digest",
} as const;

export function registerFeedbackTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "record_feedback",
    {
      description: "Rate a PharmaLLM answer from 1 (poor) to 5 (excellent), using the response_id from ask_pharmallm.",
      inputSchema: {
        rating: z.number().int().min(1).max(5),
        response_id: z.string().min(1).optional(),
        comment: z.string().min(1).optional(),
      },
    },
    async ({ rating, response_id, comment }) =>
      runTool("record_feedback", log, () =>
        client.post("/api/feedback", {
          rating,
          ...(response_id ? { response_id } : {}),
          ...(comment ? { comment } : {}),
        })
      )
  );

  server.registerTool(
    "feedback_report",
    {
      description: "Feedback overview: rating stats, low-rated answers, or the weekly digest.",
      inputSchema: { kind: z.enum(["stats", "low_rated", "weekly_digest"]) },
    },
    async ({ kind }) => runTool("feedback_report", log, () => client.get(REPORT_ROUTES[kind]))
  );
}

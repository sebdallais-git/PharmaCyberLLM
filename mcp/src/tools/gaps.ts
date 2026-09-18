// Knowledge gap tools: low-confidence questions and their resolution

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { compactGap } from "./compact.js";
import { runLongTool, runTool } from "./result.js";
import type { ToolLogger, ToolOptions } from "./result.js";

function gapsOf(payload: unknown): Array<Record<string, unknown>> {
  const gaps = typeof payload === "object" && payload !== null ? (payload as { gaps?: unknown }).gaps : undefined;
  return Array.isArray(gaps) ? gaps.filter((gap): gap is Record<string, unknown> => typeof gap === "object" && gap !== null) : [];
}

export function registerGapTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger, options: ToolOptions = {}): void {
  server.registerTool(
    "list_knowledge_gaps",
    {
      description: "Recent questions PharmaLLM answered with low confidence, with overall gap statistics.",
      inputSchema: {
        status: z
          .enum(["triggered", "skipped", "resolved", "unresolved", "detected"])
          .optional()
          .describe("Only gaps with this status (new gaps are 'triggered')"),
      },
    },
    async ({ status }) =>
      runTool("list_knowledge_gaps", log, async () => {
        const gaps = gapsOf(await client.get("/api/knowledge/gaps"));
        return {
          gaps: (status ? gaps.filter((gap) => gap.status === status) : gaps).map(compactGap),
          stats: await client.get("/api/knowledge/gaps/stats"),
        };
      })
  );

  server.registerTool(
    "resolve_knowledge_gap",
    {
      description:
        "Re-ask a knowledge gap's question through PharmaLLM's RAG pipeline and mark the gap resolved if the new " +
        "answer is confident. Use after adding knowledge for that topic. Takes about 1-2 minutes.",
      inputSchema: {
        gap_id: z.number().int().positive(),
        original_query: z.string().min(1),
        search_topic: z.string().min(1).optional(),
      },
    },
    async ({ gap_id, original_query, search_topic }, extra) =>
      runLongTool("resolve_knowledge_gap", log, extra, options, () =>
        client.post(
          "/api/knowledge/gaps/check-resolution",
          search_topic ? { gap_id, original_query, search_topic } : { gap_id, original_query },
          5 * 60 * 1000
        )
      )
  );
}

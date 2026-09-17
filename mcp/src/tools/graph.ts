// Knowledge graph tools (Neo4j via PharmaLLM)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export function registerGraphTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger): void {
  server.registerTool(
    "graph_search",
    {
      description:
        "Look up an entity in PharmaLLM's knowledge graph (company, drug, threat actor, attack, vendor, regulation…) " +
        "and return it with its neighbours and relationships.",
      inputSchema: { entity: z.string().min(1).describe("Entity name, e.g. 'LockBit' or 'Novartis'") },
    },
    async ({ entity }) => runTool("graph_search", log, () => client.post("/api/graph/search", { name: entity }))
  );

  server.registerTool(
    "graph_stats",
    { description: "Knowledge graph size: node counts by label and relationship counts by type." },
    async () => runTool("graph_stats", log, () => client.get("/api/graph/stats"))
  );
}

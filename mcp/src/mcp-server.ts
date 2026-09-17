// Builds the MCP server with every PharmaLLM tool registered

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "./pharmallm-client.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import type { ToolLogger } from "./tools/result.js";

export const SERVER_INFO = { name: "pharmallm", version: "1.0.0" };

export function buildMcpServer(client: PharmaLLMClient, log: ToolLogger): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerKnowledgeTools(server, client, log);
  return server;
}

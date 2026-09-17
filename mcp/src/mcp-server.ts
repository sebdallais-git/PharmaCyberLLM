// Builds the MCP server with every PharmaLLM tool registered

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "./pharmallm-client.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerGapTools } from "./tools/gaps.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerOperationsTools } from "./tools/operations.js";
import type { ToolLogger, ToolOptions } from "./tools/result.js";

export const SERVER_INFO = { name: "pharmallm", version: "1.0.0" };

export function buildMcpServer(client: PharmaLLMClient, log: ToolLogger, options: ToolOptions = {}): McpServer {
  // The logging capability lets long tools send keepalive notifications
  const server = new McpServer(SERVER_INFO, { capabilities: { logging: {} } });
  registerKnowledgeTools(server, client, log, options);
  registerGraphTools(server, client, log);
  registerGapTools(server, client, log, options);
  registerOperationsTools(server, client, log, options);
  registerFeedbackTools(server, client, log);
  return server;
}

// Operations tools: health, metrics, news agent, background reindex

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { compactAgentStatus } from "./compact.js";
import { runLongTool, runTool } from "./result.js";
import type { ToolLogger, ToolOptions } from "./result.js";

// 14 minutes: the tool reports its own timeout before Hermes gives up on the call at 900 s
export const NEWS_AGENT_TIMEOUT_MS = 14 * 60 * 1000;

export function registerOperationsTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger, options: ToolOptions = {}): void {
  server.registerTool(
    "system_health",
    { description: "PharmaITChat health: active LLM stack, chat/embedding/index checks, supporting services, benchmark mode." },
    async () => runTool("system_health", log, () => client.get("/api/health"))
  );

  server.registerTool(
    "dashboard_metrics",
    { description: "Usage and quality metrics: questions, confidence, response times, gaps, knowledge base health." },
    async () => runTool("dashboard_metrics", log, () => client.get("/api/dashboard/metrics"))
  );

  server.registerTool(
    "run_news_agent",
    {
      description:
        "Run PharmaITChat's news agent now: pulls pharma and cyber news for about 190 topics into the knowledge base. " +
        "Takes several minutes and uses the GPU.",
    },
    async (extra) =>
      runLongTool("run_news_agent", log, extra, options, () => client.post("/api/agent/run", {}, NEWS_AGENT_TIMEOUT_MS))
  );

  server.registerTool(
    "news_agent_status",
    { description: "Whether the news agent is running, its last run and its schedule." },
    async () => runTool("news_agent_status", log, async () => compactAgentStatus(await client.get("/api/agent/status")))
  );

  server.registerTool(
    "start_reindex",
    {
      description:
        "Start rebuilding the active stack's search indexes in the background (12-16 minutes, GPU-heavy; search is " +
        "refused while it runs). Returns a job id; poll reindex_status.",
    },
    async () => runTool("start_reindex", log, () => client.post("/api/knowledge/reindex", {}))
  );

  server.registerTool(
    "reindex_status",
    { description: "State and progress of the most recent background reindex." },
    async () => runTool("reindex_status", log, () => client.get("/api/knowledge/reindex/status"))
  );
}

// Entry point: starts the PharmaITChat MCP service

import { loadConfig } from "./config.js";
import type { McpConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { createPharmaITChatClient } from "./pharmaitchat-client.js";
import { defaultToolLogger } from "./tools/result.js";

function main(): void {
  let config: McpConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`pharmaitchat-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const client = createPharmaITChatClient(config.pharmaitchatUrl, config.pharmaitchatToken);
  const app = createHttpApp(config, client, defaultToolLogger);
  app.listen(config.port, config.host, () => {
    console.log(`pharmaitchat-mcp listening on http://${config.host}:${config.port}/mcp -> PharmaITChat at ${config.pharmaitchatUrl}`);
    console.log(config.mcpToken ? "MCP token required" : "No MCP_TOKEN: accepting loopback requests only");
  });
}

main();

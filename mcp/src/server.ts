// Entry point: starts the PharmaLLM MCP service

import { loadConfig } from "./config.js";
import type { McpConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { createPharmaLLMClient } from "./pharmallm-client.js";
import { defaultToolLogger } from "./tools/result.js";

function main(): void {
  let config: McpConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`pharmallm-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const client = createPharmaLLMClient(config.pharmallmUrl, config.pharmallmToken);
  const app = createHttpApp(config, client, defaultToolLogger);
  app.listen(config.port, config.host, () => {
    console.log(`pharmallm-mcp listening on http://${config.host}:${config.port}/mcp -> PharmaLLM at ${config.pharmallmUrl}`);
    console.log(config.mcpToken ? "MCP token required" : "No MCP_TOKEN: accepting loopback requests only");
  });
}

main();

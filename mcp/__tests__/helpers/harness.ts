// Starts a fake PharmaITChat, the MCP HTTP app, and a connected MCP client

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http.js";
import { createPharmaITChatClient } from "../../src/pharmaitchat-client.js";
import { silentToolLogger } from "../../src/tools/result.js";
import { startFakePharmaITChat } from "./fake-pharmaitchat.js";
import type { FakePharmaITChat } from "./fake-pharmaitchat.js";

export interface HarnessOptions {
  mcpToken?: string | null;
  pharmaitchatToken?: string | null;
  keepAliveMs?: number;
}

export interface Harness {
  pharma: FakePharmaITChat;
  client: Client;
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const pharma = await startFakePharmaITChat();
  const config: McpConfig = {
    port: 0,
    host: "127.0.0.1",
    mcpToken: options.mcpToken ?? null,
    pharmaitchatUrl: pharma.url,
    pharmaitchatToken: options.pharmaitchatToken ?? null,
  };
  const app = createHttpApp(config, createPharmaITChatClient(pharma.url, config.pharmaitchatToken), silentToolLogger, {
    keepAliveMs: options.keepAliveMs,
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;

  const headers: Record<string, string> = {};
  if (config.mcpToken) headers.Authorization = `Bearer ${config.mcpToken}`;
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));

  return {
    pharma,
    client,
    mcpUrl,
    async close() {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pharma.close();
    },
  };
}

export function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("");
}

export function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

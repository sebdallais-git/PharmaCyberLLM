// HTTP host for the MCP service: token check, stateless Streamable HTTP transport, health check

import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerToken, isLoopbackAddress, tokensMatch } from "./config.js";
import type { McpConfig } from "./config.js";
import { buildMcpServer } from "./mcp-server.js";
import type { PharmaLLMClient } from "./pharmallm-client.js";
import type { ToolLogger } from "./tools/result.js";

export interface McpAuthResult {
  ok: boolean;
  message: string;
}

export function authorizeMcpRequest(
  token: string | null,
  authorization: string | undefined,
  remoteAddress: string | undefined
): McpAuthResult {
  if (token) {
    const provided = bearerToken(authorization);
    return provided !== null && tokensMatch(token, provided)
      ? { ok: true, message: "" }
      : { ok: false, message: "Unauthorized: send Authorization: Bearer <MCP_TOKEN>" };
  }
  return isLoopbackAddress(remoteAddress)
    ? { ok: true, message: "" }
    : { ok: false, message: "Unauthorized: set MCP_TOKEN to accept requests from other machines" };
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createHttpApp(config: McpConfig, client: PharmaLLMClient, log: ToolLogger): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", async (_req: Request, res: Response) => {
    let pharmallm = false;
    try {
      await client.get("/api/health", 3000);
      pharmallm = true;
    } catch {
      pharmallm = false;
    }
    res.json({ ok: true, pharmallm });
  });

  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const verdict = authorizeMcpRequest(config.mcpToken, req.headers.authorization, req.socket.remoteAddress);
    if (!verdict.ok) {
      jsonRpcError(res, 401, -32001, verdict.message);
      return;
    }
    next();
  });

  // Stateless: a fresh server and transport per request, no sessions to keep
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildMcpServer(client, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`[mcp] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed");
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed");
  });

  return app;
}

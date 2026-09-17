// Shared helpers that turn tool outcomes into MCP results and log each call

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolLogger {
  (line: string): void;
}

export const defaultToolLogger: ToolLogger = (line) => console.log(line);

export const silentToolLogger: ToolLogger = () => {};

export function textResult(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Logs name, outcome and duration only: never arguments, tokens or response bodies
export async function runTool(name: string, log: ToolLogger, fn: () => Promise<unknown>): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    log(`[mcp] ${name} ok ${Date.now() - startedAt}ms`);
    return textResult(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[mcp] ${name} error ${Date.now() - startedAt}ms`);
    return errorResult(message);
  }
}

// Shared helpers that turn tool outcomes into MCP results and log each call

import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

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

// Long PharmaITChat calls send nothing until they finish; HTTP clients with a read timeout (Hermes waits 300 s
// between bytes) would give up, so long tools send a logging notification on the call's stream meanwhile
export const KEEPALIVE_INTERVAL_MS = 60_000;

export interface ToolOptions {
  keepAliveMs?: number;
}

export interface NotificationSender {
  sendNotification(notification: ServerNotification): Promise<void>;
}

export async function runLongTool(
  name: string,
  log: ToolLogger,
  sender: NotificationSender,
  options: ToolOptions,
  fn: () => Promise<unknown>
): Promise<CallToolResult> {
  const timer = setInterval(() => {
    sender
      .sendNotification({
        method: "notifications/message",
        params: { level: "info", logger: "pharmaitchat-mcp", data: `${name} is still running` },
      })
      .catch(() => {});
  }, options.keepAliveMs ?? KEEPALIVE_INTERVAL_MS);
  try {
    return await runTool(name, log, fn);
  } finally {
    clearInterval(timer);
  }
}

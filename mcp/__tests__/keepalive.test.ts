import { afterEach, describe, expect, it } from "@jest/globals";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { sendJson } from "./helpers/fake-pharmaitchat.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("keepalive notifications", () => {
  it("streams keepalives while a long tool runs and stops when it finishes", async () => {
    harness = await startHarness({ keepAliveMs: 40 });
    const notes: string[] = [];
    harness.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      notes.push(String(notification.params.data));
    });
    harness.pharma.on("POST", "/api/agent/run", (_req, res) => {
      setTimeout(() => sendJson(res, 200, { added: 3 }), 250);
    });

    const result = await harness.client.callTool({ name: "run_news_agent", arguments: {} });

    expect(isToolError(result)).toBe(false);
    expect(toolText(result)).toContain('"added": 3');
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.every((note) => note === "run_news_agent is still running")).toBe(true);
    const countAtEnd = notes.length;
    await delay(150);
    expect(notes.length).toBe(countAtEnd);
  });

  it("sends no keepalive for quick tools", async () => {
    harness = await startHarness({ keepAliveMs: 40 });
    const notes: string[] = [];
    harness.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      notes.push(String(notification.params.data));
    });
    harness.pharma.on("GET", "/api/health", (_req, res) => {
      setTimeout(() => sendJson(res, 200, { status: "healthy" }), 150);
    });

    const result = await harness.client.callTool({ name: "system_health", arguments: {} });

    expect(isToolError(result)).toBe(false);
    expect(notes).toEqual([]);
  });
});

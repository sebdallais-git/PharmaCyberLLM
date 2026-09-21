import { afterEach, describe, expect, it } from "@jest/globals";
import { request } from "node:http";
import { authorizeMcpRequest } from "../src/http.js";
import { sendJson } from "./helpers/fake-pharmaitchat.js";
import { startHarness } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

interface RawResponse {
  status: number;
  body: string;
}

// node:http lets the test send an arbitrary Host header, which fetch does not
function rawPost(url: string, headers: Record<string, string>, body: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("authorizeMcpRequest", () => {
  it("allows loopback without a token and refuses other addresses", () => {
    expect(authorizeMcpRequest(null, undefined, "127.0.0.1").ok).toBe(true);
    expect(authorizeMcpRequest(null, undefined, "::ffff:127.0.0.1").ok).toBe(true);
    const remote = authorizeMcpRequest(null, undefined, "192.168.50.20");
    expect(remote.ok).toBe(false);
    expect(remote.message).toContain("set MCP_TOKEN");
  });

  it("requires the token from everywhere once configured", () => {
    expect(authorizeMcpRequest("s3cret", undefined, "127.0.0.1").ok).toBe(false);
    expect(authorizeMcpRequest("s3cret", "Bearer wrong", "127.0.0.1").ok).toBe(false);
    expect(authorizeMcpRequest("s3cret", "Bearer s3cret", "192.168.50.20").ok).toBe(true);
  });
});

describe("HTTP app", () => {
  it("lists tools over MCP with the right token", async () => {
    harness = await startHarness({ mcpToken: "agent-secret" });
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_knowledge", "ask_pharmaitchat", "add_knowledge", "knowledge_status"])
    );
  });

  it("rejects MCP requests without the token", async () => {
    harness = await startHarness({ mcpToken: "agent-secret" });
    const resp = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(initializeBody),
    });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ error: { code: -32001 } });
  });

  it("refuses a foreign Host header without a token (DNS rebinding)", async () => {
    harness = await startHarness();
    const evil = await rawPost(harness.mcpUrl, { Host: "evil.example:3200" }, JSON.stringify(initializeBody));
    expect(evil.status).toBe(403);

    const local = await rawPost(harness.mcpUrl, { Host: "localhost:3200" }, JSON.stringify(initializeBody));
    expect(local.status).toBe(200);
    const { tools } = await harness.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("accepts any Host header once the token is configured", async () => {
    harness = await startHarness({ mcpToken: "agent-secret" });
    const resp = await rawPost(
      harness.mcpUrl,
      { Host: "mac-mini.example:3200", Authorization: "Bearer agent-secret" },
      JSON.stringify(initializeBody)
    );
    expect(resp.status).toBe(200);
  });

  it("checks the token before parsing the body", async () => {
    harness = await startHarness({ mcpToken: "agent-secret" });
    const resp = await rawPost(harness.mcpUrl, {}, "{not json");
    expect(resp.status).toBe(401);
    expect(JSON.parse(resp.body)).toMatchObject({ error: { code: -32001 } });
  });

  it("answers GET /mcp with 405", async () => {
    harness = await startHarness();
    const resp = await fetch(harness.mcpUrl);
    expect(resp.status).toBe(405);
    expect(resp.headers.get("allow")).toBe("POST");
  });

  it("reports PharmaITChat reachability on /healthz", async () => {
    harness = await startHarness();
    harness.pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy" }));
    const resp = await fetch(harness.mcpUrl.replace("/mcp", "/healthz"));
    expect(await resp.json()).toEqual({ ok: true, pharmaitchat: true });
  });
});

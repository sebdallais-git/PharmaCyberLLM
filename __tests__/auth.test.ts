import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authorizeRequest,
  bearerToken,
  createAuthMiddleware,
  isLocalHostHeader,
  isProtectedRequest,
  readApiToken,
  tokensMatch,
} from "../src/api/auth.js";

const loopback = "127.0.0.1";
const lan = "192.168.50.20";
const localHost = "localhost:3000";

describe("isProtectedRequest", () => {
  it("keeps browser UI routes and static pages open", () => {
    expect(isProtectedRequest("POST", "/api/chat")).toBe(false);
    expect(isProtectedRequest("GET", "/api/health")).toBe(false);
    expect(isProtectedRequest("POST", "/api/knowledge/upload")).toBe(false);
    expect(isProtectedRequest("GET", "/api/chat/models/")).toBe(false);
    expect(isProtectedRequest("GET", "/")).toBe(false);
    expect(isProtectedRequest("GET", "/dashboard/index.html")).toBe(false);
  });

  it("protects everything else under /api and all of /v1", () => {
    expect(isProtectedRequest("POST", "/api/knowledge/reindex")).toBe(true);
    expect(isProtectedRequest("POST", "/api/llm/complete")).toBe(true);
    expect(isProtectedRequest("GET", "/api/bench/status")).toBe(true);
    expect(isProtectedRequest("GET", "/api/knowledge/search")).toBe(true); // only POST is a browser route
    expect(isProtectedRequest("POST", "/v1/chat/completions")).toBe(true);
    expect(isProtectedRequest("GET", "/v1/models")).toBe(true);
  });

  it("protects the bare /api path", () => {
    expect(isProtectedRequest("GET", "/api")).toBe(true);
    expect(isProtectedRequest("GET", "/api/")).toBe(true);
    expect(isProtectedRequest("POST", "/API")).toBe(true);
    expect(isProtectedRequest("GET", "/apis")).toBe(false);
  });

  it("matches case-insensitively, like Express's default routing", () => {
    expect(isProtectedRequest("POST", "/API/knowledge/reindex")).toBe(true);
    expect(isProtectedRequest("GET", "/V1/models")).toBe(true);
    expect(isProtectedRequest("GET", "/Api/Knowledge/Gaps/")).toBe(true);
    expect(isProtectedRequest("GET", "/API/health")).toBe(false); // allowlisted route in another case
  });
});

describe("authorizeRequest", () => {
  const reindex = { method: "POST", path: "/api/knowledge/reindex" };

  it("allows protected routes from loopback when no token is configured", () => {
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback, host: localHost }, null).ok).toBe(true);
    expect(
      authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: "::ffff:127.0.0.1", host: localHost }, null).ok
    ).toBe(true);
    expect(
      authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback, host: "127.0.0.1:3443" }, null).ok
    ).toBe(true);
  });

  it("refuses protected routes from other machines when no token is configured", () => {
    const decision = authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: lan, host: localHost }, null);
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain("PHARMALLM_API_TOKEN");
  });

  it("refuses loopback requests with a foreign Host header when no token is configured (DNS rebinding)", () => {
    const decision = authorizeRequest(
      { ...reindex, authorization: undefined, remoteAddress: loopback, host: "evil.example:3000" },
      null
    );
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain("localhost");
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback, host: undefined }, null).ok).toBe(
      false
    );
  });

  it("requires the token from everywhere once configured", () => {
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback, host: localHost }, "s3cret").ok).toBe(
      false
    );
    expect(authorizeRequest({ ...reindex, authorization: "Bearer nope", remoteAddress: lan, host: localHost }, "s3cret").ok).toBe(
      false
    );
    expect(
      authorizeRequest({ ...reindex, authorization: "Bearer s3cret", remoteAddress: lan, host: "evil.example:3000" }, "s3cret").ok
    ).toBe(true);
  });

  it("never blocks browser routes", () => {
    expect(
      authorizeRequest({ method: "POST", path: "/api/chat", authorization: undefined, remoteAddress: lan, host: "x" }, "s3cret").ok
    ).toBe(true);
  });
});

describe("isLocalHostHeader", () => {
  it("accepts localhost names on any port and refuses everything else", () => {
    for (const host of ["localhost", "localhost:3000", "LOCALHOST:3443", "127.0.0.1", "127.0.0.1:3443", "[::1]", "[::1]:3000", "::1"]) {
      expect(isLocalHostHeader(host)).toBe(true);
    }
    for (const host of [undefined, "", "evil.example:3000", "localhost.evil.example", "127.0.0.1.nip.io:3000", "evil@localhost", "[::2]:3000", "localhost:abc"]) {
      expect(isLocalHostHeader(host)).toBe(false);
    }
  });
});

describe("token helpers", () => {
  it("parses bearer tokens, compares safely and reads the environment", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(readApiToken({ PHARMALLM_API_TOKEN: "  t0ken " })).toBe("t0ken");
    expect(readApiToken({ PHARMALLM_API_TOKEN: "" })).toBeNull();
    expect(readApiToken({})).toBeNull();
  });
});

describe("createAuthMiddleware", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  // node:http lets the test send an arbitrary Host header, which fetch does not
  function rawPost(url: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { Host: host }, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  // Mirrors src/server.ts: auth first, then JSON parsing
  async function start(token: string | null, options: { parseJson?: boolean } = {}): Promise<string> {
    const app = express();
    app.use(createAuthMiddleware(() => token));
    if (options.parseJson) app.use(express.json());
    app.post("/api/knowledge/reindex", (_req, res) => {
      res.json({ ok: true });
    });
    app.post("/api/chat", (_req, res) => {
      res.json({ ok: true });
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("returns 401 JSON without the token and passes with it", async () => {
    const url = await start("s3cret");

    const denied = await fetch(`${url}/api/knowledge/reindex`, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "Unauthorized: send Authorization: Bearer <PHARMALLM_API_TOKEN>" });

    const allowed = await fetch(`${url}/api/knowledge/reindex`, {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);

    const browser = await fetch(`${url}/api/chat`, { method: "POST" });
    expect(browser.status).toBe(200);
  });

  it("lets loopback through without a configured token", async () => {
    const url = await start(null);
    const resp = await fetch(`${url}/api/knowledge/reindex`, { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("refuses a loopback request with a foreign Host header without a configured token", async () => {
    const url = await start(null);
    const evil = await rawPost(`${url}/api/knowledge/reindex`, "evil.example:3000");
    expect(evil.status).toBe(401);
    expect((JSON.parse(evil.body) as { error: string }).error).toContain("localhost");

    expect((await rawPost(`${url}/api/knowledge/reindex`, "localhost:3000")).status).toBe(200);
    expect((await rawPost(`${url}/api/chat`, "evil.example:3000")).status).toBe(200);
  });

  it("checks the token before the body is parsed", async () => {
    const url = await start("s3cret", { parseJson: true });
    const resp = await fetch(`${url}/api/knowledge/reindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(resp.status).toBe(401);
  });

  it("blocks an uppercase-path bypass attempt without the token", async () => {
    const url = await start("s3cret");
    const denied = await fetch(`${url}/API/knowledge/reindex`, { method: "POST" });
    expect(denied.status).toBe(401);
  });
});

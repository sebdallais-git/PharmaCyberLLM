import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authorizeRequest,
  bearerToken,
  createAuthMiddleware,
  isProtectedRequest,
  readApiToken,
  tokensMatch,
} from "../src/api/auth.js";

const loopback = "127.0.0.1";
const lan = "192.168.50.20";

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
});

describe("authorizeRequest", () => {
  const reindex = { method: "POST", path: "/api/knowledge/reindex" };

  it("allows protected routes from loopback when no token is configured", () => {
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback }, null).ok).toBe(true);
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: "::ffff:127.0.0.1" }, null).ok).toBe(true);
  });

  it("refuses protected routes from other machines when no token is configured", () => {
    const decision = authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: lan }, null);
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain("PHARMALLM_API_TOKEN");
  });

  it("requires the token from everywhere once configured", () => {
    expect(authorizeRequest({ ...reindex, authorization: undefined, remoteAddress: loopback }, "s3cret").ok).toBe(false);
    expect(authorizeRequest({ ...reindex, authorization: "Bearer nope", remoteAddress: lan }, "s3cret").ok).toBe(false);
    expect(authorizeRequest({ ...reindex, authorization: "Bearer s3cret", remoteAddress: lan }, "s3cret").ok).toBe(true);
  });

  it("never blocks browser routes", () => {
    expect(authorizeRequest({ method: "POST", path: "/api/chat", authorization: undefined, remoteAddress: lan }, "s3cret").ok).toBe(true);
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

  async function start(token: string | null): Promise<string> {
    const app = express();
    app.use(createAuthMiddleware(() => token));
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
});

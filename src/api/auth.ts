// API token authentication: protects agent and operations routes, keeps browser UI routes open

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

// Routes the chat UI and dashboard call from the browser (method, path); these stay open
export const BROWSER_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/api/chat"],
  ["GET", "/api/chat/models"],
  ["POST", "/api/chat/transcribe"],
  ["POST", "/api/knowledge/search"],
  ["GET", "/api/knowledge/stats"],
  ["POST", "/api/knowledge/upload"],
  ["POST", "/api/knowledge/ingest-text"],
  ["POST", "/api/agent/run"],
  ["GET", "/api/agent/status"],
  ["GET", "/api/dashboard/metrics"],
  ["GET", "/api/dashboard/chromadb-misses"],
  ["GET", "/api/graph/stats"],
  ["GET", "/api/health"],
];

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface AuthRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  remoteAddress: string | undefined;
}

export interface AuthDecision {
  ok: boolean;
  message: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Hash both sides first so timingSafeEqual always compares equal-length buffers
export function tokensMatch(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function isProtectedRequest(method: string, path: string): boolean {
  // Lowercase to mirror Express's default case-insensitive, non-strict routing:
  // otherwise "/API/..." or "/V1/..." would reach protected handlers unauthenticated
  const normalized = (path.length > 1 ? path.replace(/\/+$/, "") : path).toLowerCase();
  if (normalized === "/v1" || normalized.startsWith("/v1/")) return true;
  if (!normalized.startsWith("/api/")) return false;
  const upper = method.toUpperCase();
  return !BROWSER_ROUTES.some(([routeMethod, routePath]) => routeMethod === upper && routePath === normalized);
}

export function authorizeRequest(request: AuthRequest, token: string | null): AuthDecision {
  if (!isProtectedRequest(request.method, request.path)) return { ok: true, message: "" };

  if (token) {
    const provided = bearerToken(request.authorization);
    return provided !== null && tokensMatch(token, provided)
      ? { ok: true, message: "" }
      : { ok: false, message: "Unauthorized: send Authorization: Bearer <PHARMALLM_API_TOKEN>" };
  }

  // No token configured: operations stay local-only
  return isLoopbackAddress(request.remoteAddress)
    ? { ok: true, message: "" }
    : {
        ok: false,
        message: "Unauthorized: set PHARMALLM_API_TOKEN (scripts/switch-stack.sh token) to allow requests from other machines",
      };
}

export function readApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PHARMALLM_API_TOKEN?.trim() || null;
}

export function createAuthMiddleware(getToken: () => string | null = () => readApiToken()): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = authorizeRequest(
      {
        method: req.method,
        path: req.path,
        authorization: req.headers.authorization,
        remoteAddress: req.socket.remoteAddress,
      },
      getToken()
    );
    if (!decision.ok) {
      res.status(401).json({ error: decision.message });
      return;
    }
    next();
  };
}

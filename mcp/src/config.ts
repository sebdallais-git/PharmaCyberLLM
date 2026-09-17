// Environment configuration for the PharmaLLM MCP service

import { createHash, timingSafeEqual } from "node:crypto";

export interface McpConfig {
  port: number;
  host: string;
  mcpToken: string | null;
  pharmallmUrl: string;
  pharmallmToken: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const port = Number(env.MCP_PORT ?? "3200");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_PORT "${env.MCP_PORT}"`);
  }

  const host = env.MCP_HOST ?? "127.0.0.1";
  const mcpToken = env.MCP_TOKEN?.trim() || null;
  if (!isLoopbackHost(host) && !mcpToken) {
    throw new Error(`MCP_TOKEN is required when MCP_HOST (${host}) is not a loopback address`);
  }

  return {
    port,
    host,
    mcpToken,
    pharmallmUrl: (env.PHARMALLM_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    pharmallmToken: env.PHARMALLM_API_TOKEN?.trim() || null,
  };
}

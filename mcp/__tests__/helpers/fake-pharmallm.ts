// Minimal HTTP server that stands in for PharmaLLM's REST API in tests

import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeHandler {
  (req: FakeRequest, res: ServerResponse): void;
}

export interface FakePharmaLLM {
  url: string;
  requests: FakeRequest[];
  on(method: string, path: string, handler: FakeHandler): void;
  close(): Promise<void>;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function sendSse(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

export async function startFakePharmaLLM(): Promise<FakePharmaLLM> {
  const routes = new Map<string, FakeHandler>();
  const requests: FakeRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      const recorded: FakeRequest = {
        method: req.method ?? "",
        path,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      };
      requests.push(recorded);
      const handler = routes.get(`${recorded.method} ${path}`);
      if (handler) {
        handler(recorded, res);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // fetch keeps connections alive; drop them so close() doesn't wait
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

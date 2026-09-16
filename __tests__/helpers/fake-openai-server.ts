// Minimal HTTP server that stands in for an OpenAI-compatible model server in tests

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeServer(
  handler: (req: RecordedRequest, res: ServerResponse) => void
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as unknown) : null,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // fetch keeps connections alive; drop them so close() doesn't wait
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function sendSse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

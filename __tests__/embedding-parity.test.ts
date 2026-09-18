import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "lib", "embedding-parity.py");
const fixturePath = join(process.cwd(), "__tests__", "fixtures", "embedding-reference.json");
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake embeddings endpoint returning whatever vector the test wants
async function startFakeEmbedder(vector: number[]): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: vector }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// spawnSync fully blocks Node's event loop (it runs the child on its own dedicated libuv
// loop, not the default one), so it can never service the in-process fake HTTP server's
// 'request' event while waiting for the child — the two deadlock. spawn() keeps the event
// loop running so the fake server can respond while we await the child's exit.
function run(url: string, fixture: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/python3", [script, url, "test-model", fixture]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("close", (status: number | null) => resolve({ status, stdout, stderr }));
  });
}

describe("embedding-parity.py", () => {
  it("passes when the vectors match the reference", async () => {
    const reference = JSON.parse(readFileSync(fixturePath, "utf-8")) as { vector: number[] };
    const url = await startFakeEmbedder(reference.vector);

    const result = await run(url, fixturePath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cosine=1.0");
  });

  it("fails when the vectors have drifted", async () => {
    const reference = JSON.parse(readFileSync(fixturePath, "utf-8")) as { vector: number[] };
    const drifted = reference.vector.map((value, index) => (index % 3 === 0 ? value * -1 : value * 0.2));
    const url = await startFakeEmbedder(drifted);

    const result = await run(url, fixturePath);

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/cosine=/);
  });

  it("fails loudly when the server is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-"));
    dirs.push(dir);
    const fixture = join(dir, "ref.json");
    writeFileSync(fixture, JSON.stringify({ text: "probe", model: "m", vector: [1, 0, 0] }));

    const result = await run("http://127.0.0.1:9", fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/embedding parity check failed/i);
  });
});

describe("switch-stack.sh parity guard", () => {
  it("checks parity after starting oMLX and before the app", () => {
    const shell = readFileSync(join(process.cwd(), "scripts", "switch-stack.sh"), "utf-8");
    expect(shell).toContain("check_embedding_parity()");
    expect(shell).toContain("scripts/lib/embedding-parity.py");
    expect(shell).toContain("start_omlx && check_embedding_parity");
  });
});

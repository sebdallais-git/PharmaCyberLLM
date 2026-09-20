// Change 2 (owner decision): the 188 topic queries news-agent.ts used to
// scrub via Google News RSS now belong solely to the watchlist's 02:30
// ingest, which already fetches every one of them as `news` feeds with its
// own dedupe. This suite pins that runNewsScrub (what runNewsAgent actually
// runs once its guard checks pass) no longer fetches anything or writes to
// ChromaDB for topics, while its state file and return shape stay intact.
//
// Like news-agent-config.test.ts, this deliberately does NOT import
// news-agent at the top: KNOWLEDGE_DIR/.agent-state.json is computed from
// process.cwd() at module-load time, and the real project's knowledge/
// directory must never be touched by a test run. Each test points cwd at a
// throwaway project first, then imports the module fresh.
//
// runNewsScrub is called directly rather than through runNewsAgent: one of
// runNewsAgent's own guard checks (llm.isReachable()) makes a real network
// probe, which this suite must never trigger. A separate test below drives
// runNewsAgent itself through its "index not verified yet" skip path (the
// default at fresh import, with no live services involved) to pin that its
// return shape is unaffected.

import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realCwd = process.cwd();
const dirs: string[] = [];

function emptyProjectDir(): string {
  const root = mkdtempSync(join(tmpdir(), "news-agent-scrub-"));
  dirs.push(root);
  return root;
}

afterEach(() => {
  process.chdir(realCwd);
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runNewsScrub (Change 2: topics moved to the watchlist ingest)", () => {
  it("makes no fetch calls, writes nothing but its own state, and returns zeros", async () => {
    const projectDir = emptyProjectDir();
    process.chdir(projectDir);
    // KNOWLEDGE_DIR is computed from process.cwd() at module-load time, so a
    // module cached from an earlier test (a different cwd) must be dropped.
    jest.resetModules();

    const fetchSpy = jest.spyOn(globalThis, "fetch");

    const { runNewsScrub } = await import("../src/services/news-agent.js");
    const result = await runNewsScrub();

    expect(result).toEqual({ newArticles: 0, topics: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const statePath = join(projectDir, "knowledge", ".agent-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { lastRun: string; seenTitles: string[] };
    expect(state.lastRun.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(state.lastRun))).toBe(false);
  });

  it("preserves an existing state file's seenTitles untouched, only advancing lastRun", async () => {
    const projectDir = emptyProjectDir();
    mkdirSync(join(projectDir, "knowledge"), { recursive: true });
    const statePath = join(projectDir, "knowledge", ".agent-state.json");
    writeFileSync(statePath, JSON.stringify({ lastRun: "2020-01-01T00:00:00.000Z", seenTitles: ["old headline"] }));
    process.chdir(projectDir);
    jest.resetModules();

    const { runNewsScrub } = await import("../src/services/news-agent.js");
    const before = Date.now();
    await runNewsScrub();

    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { lastRun: string; seenTitles: string[] };
    expect(state.seenTitles).toEqual(["old headline"]);
    expect(Date.parse(state.lastRun)).toBeGreaterThanOrEqual(before);
  });

  it("no longer references chromadb-store or Google News RSS in source, guarding against a regression that reintroduces the topic scrub", () => {
    const source = readFileSync(join(realCwd, "src", "services", "news-agent.ts"), "utf-8");
    expect(source).not.toContain("chromadb-store");
    expect(source).not.toContain("news.google.com");
    expect(source).not.toContain("addToChromaDB");
  });
});

describe("runNewsAgent's return-shape contract", () => {
  beforeEach(() => {
    process.chdir(emptyProjectDir());
    jest.resetModules();
  });

  it("still returns { newArticles, topics } when skipped (index not verified yet, the default at import), touching no network", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");

    const { runNewsAgent } = await import("../src/services/news-agent.js");
    const result = await runNewsAgent();

    expect(result).toEqual({ newArticles: 0, topics: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

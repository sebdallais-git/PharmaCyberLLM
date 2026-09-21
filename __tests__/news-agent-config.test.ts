// I2: a bad edit to config/watchlist.yaml must not brick the API server.
//
// src/services/news-agent.ts used to call loadWatchlist() at module scope and
// src/server.ts imports it, so a typo in that file -- which the README tells
// the owner to edit, and which he edits from an iPad -- took the whole
// PharmaITChat server down at boot with a YAML error for a stack trace.
//
// This suite deliberately does NOT import news-agent at the top: the point is
// what happens at IMPORT time with a broken config on disk, so the import has
// to happen inside the test, after the working directory has been pointed at
// a throwaway project. Nothing here reaches ChromaDB, a model or the network
// -- importing the module only registers its own imports.

import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realCwd = process.cwd();
const dirs: string[] = [];

afterEach(() => {
  process.chdir(realCwd);
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A project directory whose config/watchlist.yaml is exactly the kind of
// damage a hurried phone edit does: a mapping value where a list belongs.
function brokenConfigProject(): string {
  const root = mkdtempSync(join(tmpdir(), "news-agent-broken-config-"));
  dirs.push(root);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "watchlist.yaml"), "customers:\n  - id: roche\n   name: Roche\n");
  return root;
}

describe("news-agent with an unreadable watchlist config", () => {
  it("imports without throwing and reports no topics rather than taking the server down", async () => {
    process.chdir(brokenConfigProject());

    const module = await import("../src/services/news-agent.js");

    expect(module.getAgentTopics()).toEqual([]);
    // Still no throw on a second call: the empty list is memoized, not
    // re-parsed (and re-logged) per scrub.
    expect(module.getAgentTopics()).toEqual([]);
  });
});

describe("createTopicsLoader", () => {
  it("returns the config's topic strings and reads the file only once", async () => {
    const { createTopicsLoader } = await import("../src/services/news-agent.js");
    let loads = 0;
    const topics = createTopicsLoader(() => {
      loads++;
      return {
        entities: new Map(),
        topics: [
          { query: "pharma ransomware breach", domains: ["cyber" as const] },
          { query: "pharma FDA approval", domains: [] },
        ],
        priority: [],
        notes: [],
      };
    });

    expect(topics()).toEqual(["pharma ransomware breach", "pharma FDA approval"]);
    expect(topics()).toEqual(["pharma ransomware breach", "pharma FDA approval"]);
    expect(loads).toBe(1);
  });

  it("falls back to an empty list when the config cannot be parsed, and stops retrying", async () => {
    const { createTopicsLoader } = await import("../src/services/news-agent.js");
    let loads = 0;
    const topics = createTopicsLoader(() => {
      loads++;
      throw new Error("watchlist config must be an object");
    });

    expect(topics()).toEqual([]);
    expect(topics()).toEqual([]);
    expect(loads).toBe(1);
  });
});

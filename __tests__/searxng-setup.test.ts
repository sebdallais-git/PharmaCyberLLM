import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// On 2026-09-26 every search the gap loop made came back empty: SearXNG ran
// its default general-web engines (Google, DuckDuckGo, Startpage, Brave), and
// all four answered this machine with CAPTCHAs, "access denied" or rate
// limits. The config now lives in the repo and turns on engines that tolerate
// self-hosted instances; scripts/setup-searxng.sh recreates the container
// with it mounted.

const configPath = join(process.cwd(), "config", "searxng", "settings.yml");

interface EngineOverride {
  name: string;
  disabled?: boolean;
}

interface SearxSettings {
  use_default_settings?: unknown;
  server?: Record<string, unknown>;
  search?: { formats?: string[] };
  engines?: EngineOverride[];
}

describe("config/searxng/settings.yml", () => {
  const settings = parse(readFileSync(configPath, "utf-8")) as SearxSettings;

  it("builds on SearXNG's defaults instead of copying them", () => {
    expect(settings.use_default_settings).toBe(true);
  });

  it("serves JSON, which the n8n workflow and the chat's web search request", () => {
    expect(settings.search?.formats).toEqual(expect.arrayContaining(["html", "json"]));
  });

  it("turns on general-web engines beyond the four that block self-hosted instances", () => {
    const enabled = (settings.engines ?? []).filter((e) => e.disabled === false).map((e) => e.name);
    expect(enabled).toEqual(expect.arrayContaining(["bing", "mojeek", "qwant"]));
  });

  it("holds no secret: the key comes from SEARXNG_SECRET", () => {
    expect(settings.server?.secret_key).toBeUndefined();
    expect(readFileSync(configPath, "utf-8")).not.toMatch(/secret_key\s*:/);
  });
});

describe("scripts/setup-searxng.sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Runs a copy of the script in a sandbox whose docker is a recorder, so no
  // container is touched. The recorder also notes whether SEARXNG_SECRET was
  // in its environment, since `-e SEARXNG_SECRET` passes it by name only.
  function setup(existingSecret?: string) {
    const root = mkdtempSync(join(tmpdir(), "searxng-setup-"));
    dirs.push(root);
    const scripts = join(root, "scripts");
    const run = join(root, "data", "run");
    const bin = join(root, "bin");
    for (const dir of [scripts, run, bin, join(root, "config", "searxng")]) mkdirSync(dir, { recursive: true });
    copyFileSync(join(process.cwd(), "scripts", "setup-searxng.sh"), join(scripts, "setup-searxng.sh"));
    copyFileSync(configPath, join(root, "config", "searxng", "settings.yml"));
    if (existingSecret !== undefined) writeFileSync(join(run, "searxng-secret"), `${existingSecret}\n`);

    const calls = join(root, "docker.log");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash\necho "docker $* | secret_in_env=\${SEARXNG_SECRET:+yes}" >>"${calls}"\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);

    const result = spawnSync("bash", [join(scripts, "setup-searxng.sh")], {
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });
    const log = existsSync(calls) ? readFileSync(calls, "utf-8").split("\n").filter(Boolean) : [];
    return { result, log, root, run };
  }

  it("replaces the container with one that mounts the repo config read-only", () => {
    const { result, log, root } = setup("s3cret");
    expect(result.status).toBe(0);
    const rm = log.findIndex((l) => l.startsWith("docker rm -f searxng"));
    const create = log.findIndex((l) => l.startsWith("docker run "));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(rm);
    const runLine = log[create];
    expect(runLine).toContain("--name searxng");
    expect(runLine).toContain("--restart unless-stopped");
    expect(runLine).toContain("-p 8888:8080");
    expect(runLine).toContain(`-v ${join(root, "config", "searxng", "settings.yml")}:/etc/searxng/settings.yml:ro`);
    expect(runLine).toMatch(/ searxng\/searxng(\s|$)/);
  });

  it("passes the secret through the environment, never as an argument", () => {
    const { log } = setup("s3cret");
    const runLine = log.find((l) => l.startsWith("docker run ")) ?? "";
    expect(runLine).toContain("-e SEARXNG_SECRET ");
    expect(runLine).not.toContain("s3cret");
    expect(runLine).toContain("secret_in_env=yes");
  });

  it("creates a secret once, readable only by the owner", () => {
    const { run } = setup();
    const file = join(run, "searxng-secret");
    const first = readFileSync(file, "utf-8").trim();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing secret", () => {
    const { run } = setup("keep-me");
    expect(readFileSync(join(run, "searxng-secret"), "utf-8").trim()).toBe("keep-me");
  });
});

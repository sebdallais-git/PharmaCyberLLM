import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectDir = process.cwd();
const dirs: string[] = [];
const API_TOKEN = "api-token-value-1111";
const MCP_TOKEN = "mcp-token-value-2222";
const BOT_TOKEN = "123456:bot-token-value-3333";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  home: string;
  runDir: string;
  agentsDir: string;
  calls: string;
}

// Temp HERMES_HOME, run dir with both token files, and stub hermes/launchctl that log their arguments
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "hermes-setup-"));
  dirs.push(root);
  const home = join(root, "hermes-home");
  const runDir = join(root, "run");
  const agentsDir = join(root, "LaunchAgents");
  const calls = join(root, "calls.log");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "api-token"), `${API_TOKEN}\n`);
  writeFileSync(join(runDir, "mcp-token"), `${MCP_TOKEN}\n`);
  for (const name of ["hermes", "launchctl"]) {
    writeStub(join(root, name), name);
  }
  return { root, home, runDir, agentsDir, calls };
}

// Logs its arguments to $STUB_CALLS; extra lines let a test decide the exit status
function writeStub(path: string, name: string, extra: string[] = []): void {
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      `printf '${name}' >> "$STUB_CALLS"`,
      `printf ' [%s]' "$@" >> "$STUB_CALLS"`,
      'echo >> "$STUB_CALLS"',
      ...extra,
    ].join("\n")
  );
  chmodSync(path, 0o755);
}

function setup(box: Sandbox, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [join(projectDir, "scripts", "hermes-setup.sh"), ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: box.root,
      HERMES_HOME: box.home,
      PHARMALLM_RUN_DIR: box.runDir,
      LAUNCH_AGENTS_DIR: box.agentsDir,
      HERMES_BIN: join(box.root, "hermes"),
      LAUNCHCTL_BIN: join(box.root, "launchctl"),
      MCP_HEALTH_URL: "http://127.0.0.1:9/healthz",
      STUB_CALLS: box.calls,
      ...extraEnv,
    },
  });
}

function envFile(box: Sandbox): string {
  return readFileSync(join(box.home, ".env"), "utf-8");
}

// A curl that answers /healthz with `body`; the script finds it first via PATH (see stubPath)
function writeCurlStub(box: Sandbox, body: string): void {
  const path = join(box.root, "curl");
  writeFileSync(path, ["#!/bin/bash", "cat <<'HEALTHJSON'", body, "HEALTHJSON"].join("\n"));
  chmodSync(path, 0o755);
}

function stubPath(box: Sandbox): Record<string, string> {
  return { PATH: `${box.root}:/usr/bin:/bin` };
}

describe("hermes-setup.sh install-config", () => {
  it("installs config and SOUL.md and fills a private .env without printing secrets", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(0);
    expect(readFileSync(join(box.home, "config.yaml"), "utf-8")).toBe(
      readFileSync(join(projectDir, "hermes", "config.template.yaml"), "utf-8")
    );
    expect(existsSync(join(box.home, "SOUL.md"))).toBe(true);
    expect(statSync(join(box.home, ".env")).mode & 0o777).toBe(0o600);
    const env = envFile(box);
    expect(env).toContain(`PHARMALLM_API_TOKEN=${API_TOKEN}`);
    expect(env).toContain(`PHARMALLM_MCP_TOKEN=${MCP_TOKEN}`);
    expect(env).toContain("PHARMALLM_URL=http://localhost:3000");
    expect(env).toContain("PHARMALLM_MCP_URL=http://127.0.0.1:3200/mcp");
    expect(env).toContain("SEARXNG_URL=http://localhost:8888");
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
    expect(env).toContain("TELEGRAM_ALLOWED_USERS=424242");
    expect(env).toContain("TELEGRAM_HOME_CHANNEL=424242");
    const output = result.stdout + result.stderr;
    for (const secret of [API_TOKEN, MCP_TOKEN, BOT_TOKEN]) expect(output).not.toContain(secret);
  });

  it("takes only the first allowed user as the home channel", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "111,222" });

    expect(result.status).toBe(0);
    const env = envFile(box);
    expect(env).toContain("TELEGRAM_ALLOWED_USERS=111,222");
    expect(env).toContain("TELEGRAM_HOME_CHANNEL=111\n");
  });

  it("replaces .env atomically and leaves no temporary file behind", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(0);
    expect(readdirSync(box.home).filter((name) => name.startsWith(".env") && name !== ".env")).toEqual([]);
  });

  it("names the token helper when a PharmaLLM token is missing", () => {
    const box = sandbox();
    rmSync(join(box.runDir, "api-token"));

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Missing PHARMALLM_API_TOKEN");
    expect(output).toContain("scripts/switch-stack.sh token");
  });

  it("keeps existing values on re-run and backs up a changed config", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    writeFileSync(join(box.home, "config.yaml"), "edited: true\n");

    const result = setup(box, ["install-config"]);

    expect(result.status).toBe(0);
    expect(envFile(box)).toContain(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
    expect(envFile(box).match(/^TELEGRAM_BOT_TOKEN=/gm)).toHaveLength(1);
    const backups = readdirSync(box.home).filter((name) => name.startsWith("config.yaml.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(box.home, backups[0]), "utf-8")).toBe("edited: true\n");
  });

  it("fails with instructions when Telegram values are missing and nobody can type them", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"]);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing TELEGRAM_BOT_TOKEN");
  });
});

describe("hermes-setup.sh install-cron", () => {
  it("creates all four jobs when none exist", () => {
    const box = sandbox();

    const result = setup(box, ["install-cron"]);

    expect(result.status).toBe(0);
    const calls = readFileSync(box.calls, "utf-8").trim().split("\n");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("hermes [cron] [create] [0 6 * * *] [Scheduled job: morning news digest.");
    expect(calls[0]).toContain("[--name] [pharmallm-news-digest] [--deliver] [telegram]");
    expect(calls[2]).toContain("[--name] [pharmallm-health-watch]");
  });

  it("edits jobs that already exist by name instead of duplicating them", () => {
    const box = sandbox();
    mkdirSync(join(box.home, "cron"), { recursive: true });
    writeFileSync(
      join(box.home, "cron", "jobs.json"),
      JSON.stringify({ jobs: [{ id: "abc123", name: "pharmallm-health-watch", schedule: "0 9 * * *" }] })
    );

    const result = setup(box, ["install-cron"]);

    expect(result.status).toBe(0);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toContain("hermes [cron] [edit] [abc123] [--schedule] [0 9,19 * * *] [--prompt]");
    expect(calls.match(/\[create\]/g)).toHaveLength(3);
  });
});

describe("hermes-setup.sh install-services", () => {
  it("renders the MCP plist with node's path, loads it and installs the gateway", () => {
    const box = sandbox();

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    const plist = readFileSync(join(box.agentsDir, "com.pharmallm.mcp.plist"), "utf-8");
    expect(plist).toContain("<key>NODE_BIN</key><string>/opt/fake/bin/node</string>");
    expect(plist).toContain(`<string>${projectDir}/scripts/run-mcp.sh</string>`);
    expect(plist).not.toContain("__");
    expect(plist).not.toContain(MCP_TOKEN);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toMatch(/launchctl \[bootstrap\] \[gui\/\d+\] \[.*com\.pharmallm\.mcp\.plist\]/);
    expect(calls).toContain("hermes [gateway] [install] [--force] [--start-now] [--start-on-login]");
  });

  it("bakes MCP_HOST into the plist so a LAN move survives a reboot", () => {
    const box = sandbox();

    // launchctl setenv is domain-wide and lost on reboot; the plist is what persists
    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node", MCP_HOST: "0.0.0.0" });

    expect(result.status).toBe(0);
    const plist = readFileSync(join(box.agentsDir, "com.pharmallm.mcp.plist"), "utf-8");
    expect(plist).toContain("<key>MCP_HOST</key><string>0.0.0.0</string>");
    expect(plist).not.toContain("__");
  });

  it("defaults MCP_HOST to loopback when it is unset", () => {
    const box = sandbox();

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    const plist = readFileSync(join(box.agentsDir, "com.pharmallm.mcp.plist"), "utf-8");
    expect(plist).toContain("<key>MCP_HOST</key><string>127.0.0.1</string>");
  });

  it(
    "retries a bootstrap that fails right after bootout",
    () => {
      const box = sandbox();
      // launchd answers "Input/output error" on the first bootstraps after a bootout
      writeStub(join(box.root, "launchctl"), "launchctl", [
        'case "$1" in',
        '  bootstrap) [ "$(grep -c "\\[bootstrap\\]" "$STUB_CALLS")" -ge 3 ] || exit 1 ;;',
        "esac",
        "exit 0",
      ]);

      const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

      expect(result.status).toBe(0);
      const calls = readFileSync(box.calls, "utf-8");
      expect(calls.match(/\[bootstrap\]/g)).toHaveLength(3);
      expect(calls).toContain("hermes [gateway] [install]");
    },
    30_000
  );
});

describe("hermes-setup.sh all", () => {
  it("stops before touching services when install-config fails", () => {
    const box = sandbox();

    const result = setup(box, ["all"]);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing TELEGRAM_BOT_TOKEN");
    expect(existsSync(box.calls)).toBe(false);
  });
});

describe("hermes-setup.sh install-plugin", () => {
  it("copies only the plugin's own files, enables it and restarts the gateway", () => {
    const box = sandbox();

    const result = setup(box, ["install-plugin"]);

    expect(result.status).toBe(0);
    const dest = join(box.home, "plugins", "pharmallm-switch");
    expect(readdirSync(dest).sort()).toEqual(["__init__.py", "plugin.yaml", "tap.py"]);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toContain("hermes [plugins] [enable] [pharmallm-switch]");
    expect(calls).toContain("hermes [gateway] [restart]");
    expect(calls.indexOf("[plugins] [enable]")).toBeLessThan(calls.indexOf("[gateway] [restart]"));
  });
});

describe("hermes-setup.sh check: plugin", () => {
  function checkOutput(box: Sandbox): string {
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    const result = setup(box, ["check"]);
    return result.stdout + result.stderr;
  }

  it("reports the plugin as missing before install-plugin", () => {
    expect(checkOutput(sandbox())).toContain("plugin pharmallm-switch: missing");
  });

  it("reports a plugin loaded by the running gateway only when pid and start time both match", () => {
    const box = sandbox();
    setup(box, ["install-plugin"]);
    mkdirSync(box.home, { recursive: true });
    writeFileSync(join(box.home, "gateway.pid"), JSON.stringify({ pid: 4242, start_time: 777, kind: "hermes-gateway" }));
    writeFileSync(join(box.home, "pharmallm-switch.ready.json"), JSON.stringify({ pid: 4242, start_time: 777 }));
    expect(checkOutput(box)).toContain("plugin pharmallm-switch: loaded by the running gateway");

    writeFileSync(join(box.home, "pharmallm-switch.ready.json"), JSON.stringify({ pid: 4242, start_time: 1 }));
    expect(checkOutput(box)).toContain("plugin pharmallm-switch: installed, waiting for a gateway restart");
  });
});

describe("hermes-setup.sh check", () => {
  it("reports variable names without printing their values", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    const result = setup(box, ["check"]);

    const output = result.stdout + result.stderr;
    expect(output).toContain("TELEGRAM_BOT_TOKEN: set");
    expect(output).toContain("PHARMALLM_MCP_TOKEN: set");
    expect(output).toContain(".env permissions: 600");
    for (const secret of [API_TOKEN, MCP_TOKEN, BOT_TOKEN, "424242"]) expect(output).not.toContain(secret);
  });

  it("finds services loaded in the user domain as well as gui", () => {
    const box = sandbox();
    // `hermes gateway install` loads ai.hermes.gateway in user/$UID, not gui/$UID
    writeStub(join(box.root, "launchctl"), "launchctl", ['case "${2:-}" in user/*) exit 0 ;; esac', "exit 1"]);
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    const result = setup(box, ["check"]);

    const output = result.stdout + result.stderr;
    expect(output).toContain("service com.pharmallm.mcp: loaded");
    expect(output).toContain("service ai.hermes.gateway: loaded");
    expect(output).not.toContain("not loaded");
  });

  it("calls the MCP service healthy only when PharmaLLM behind it answers", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    writeCurlStub(box, '{"ok":true,"pharmallm":true}');

    const result = setup(box, ["check"], stubPath(box));

    const output = result.stdout + result.stderr;
    expect(output).toContain("pharmallm-mcp: healthy");
    expect(output).not.toContain("PharmaLLM not reachable");
  });

  it("reports a problem when the MCP service is up but the app behind it is down", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    // /healthz answers 200 with pharmallm:false while the app is stopped — a 200 alone means nothing
    writeCurlStub(box, '{"ok":true,"pharmallm":false}');

    const result = setup(box, ["check"], stubPath(box));

    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("pharmallm-mcp: up, PharmaLLM not reachable");
    expect(output).not.toContain("pharmallm-mcp: healthy");
  });

  it("reports the MCP service as not answering when nothing listens", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    // MCP_HEALTH_URL points at port 9, which refuses the connection
    const result = setup(box, ["check"]);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("pharmallm-mcp: not answering");
  });
});

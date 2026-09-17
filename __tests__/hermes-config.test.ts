import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const hermesDir = join(process.cwd(), "hermes");
const configText = readFileSync(join(hermesDir, "config.template.yaml"), "utf-8");
const config = parse(configText) as Record<string, unknown>;

// Walks a parsed YAML object by key path; fails the test when a key is missing
function at(path: string): unknown {
  let value: unknown = config;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      throw new Error(`config.template.yaml has no ${path}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

interface CronJob {
  name: string;
  schedule: string;
  deliver: string;
  prompt: string;
}

const jobs = JSON.parse(readFileSync(join(hermesDir, "cron", "jobs.json"), "utf-8")) as CronJob[];

describe("hermes/config.template.yaml", () => {
  it("references only documented environment variables", () => {
    const referenced = [...configText.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]);
    expect(new Set(referenced)).toEqual(new Set(["PHARMALLM_URL", "PHARMALLM_MCP_URL", "PHARMALLM_MCP_TOKEN"]));
    expect(at("providers.pharmallm.key_env")).toBe("PHARMALLM_API_TOKEN");
    expect(configText).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("uses the PharmaLLM gateway with a 64k context and no model discovery", () => {
    expect(at("model.provider")).toBe("custom:pharmallm");
    expect(at("model.default")).toBe("pharmallm-local");
    expect(at("model.context_length")).toBe(65536);
    expect(at("providers.pharmallm.api")).toBe("${PHARMALLM_URL}/v1");
    expect(at("providers.pharmallm.discover_models")).toBe(false);
    expect(at("providers.pharmallm.request_timeout_seconds")).toBe(1800);
    expect(at("providers.pharmallm.models.pharmallm-local.context_length")).toBe(65536);
  });

  it("pins the cron provider so scheduled runs resolve credentials", () => {
    // Hermes stores a bare "custom" snapshot per job and resolves cron runs from cron.* first
    expect(at("cron.model")).toBe("pharmallm-local");
    expect(at("cron.model_provider")).toBe("custom:pharmallm");
  });

  it("connects to pharmallm-mcp with a bearer token, long timeout and no start_reindex", () => {
    expect(at("mcp_servers.pharmallm.url")).toBe("${PHARMALLM_MCP_URL}");
    expect(at("mcp_servers.pharmallm.headers.Authorization")).toBe("Bearer ${PHARMALLM_MCP_TOKEN}");
    expect(at("mcp_servers.pharmallm.timeout")).toBe(900);
    expect(at("mcp_servers.pharmallm.connect_timeout")).toBe(30);
    expect(at("mcp_servers.pharmallm.tools.exclude")).toEqual(["start_reindex"]);
  });

  it("sandboxes the shell, denies unattended approvals and keeps web search local", () => {
    expect(at("terminal.backend")).toBe("docker");
    expect(at("terminal.docker_network")).toBe(false);
    expect(at("terminal.docker_mount_cwd_to_workspace")).toBe(false);
    expect(at("terminal.docker_volumes")).toEqual([]);
    // The sandbox must fit the Docker VM, which Neo4j and SearXNG already share
    expect(at("terminal.container_cpu")).toBe(1);
    expect(at("terminal.container_memory")).toBe(512);
    expect(at("approvals.cron_mode")).toBe("deny");
    expect(at("approvals.unattended_mode")).toBe("deny");
    expect(at("approvals.single_query_mode")).toBe("deny");
    expect(at("skills.write_approval")).toBe(true);
    expect(at("web.search_backend")).toBe("searxng");
    expect(at("web.keyless_fallback")).toBe(false);
    expect(at("web.keyless_rescue")).toBe(false);
    expect(at("security.allow_private_urls")).toBe(false);
    expect(at("unauthorized_dm_behavior")).toBe("ignore");
    expect(at("agent.disabled_toolsets")).toEqual([
      "browser",
      "computer_use",
      "code_execution",
      "image_gen",
      "tts",
      "delegation",
      "kanban",
      "vision",
    ]);
    const telegram = at("platform_toolsets.telegram") as string[];
    expect(telegram).toContain("pharmallm");
    expect(telegram).not.toContain("cronjob");
  });

  it("gives unattended runs no ungated write channel", () => {
    // approvals.cron_mode gates dangerous *commands* only; MCP calls are never approval-gated, so the
    // cron toolset list and a write-limited MCP server are the real controls for scheduled runs
    expect(at("platform_toolsets.cron")).toEqual(["session_search", "pharmallm_cron"]);
    const cron = at("platform_toolsets.cron") as string[];
    for (const toolset of ["web", "search", "memory", "terminal", "file", "skills", "pharmallm"]) {
      expect(cron).not.toContain(toolset);
    }
    expect(at("mcp_servers.pharmallm_cron.tools.exclude")).toEqual(["start_reindex", "add_knowledge"]);
    // Same endpoint and credentials as the interactive server, only the tool filter differs
    expect(at("mcp_servers.pharmallm_cron.url")).toBe(at("mcp_servers.pharmallm.url"));
    expect(at("mcp_servers.pharmallm_cron.headers.Authorization")).toBe(
      at("mcp_servers.pharmallm.headers.Authorization")
    );
    expect(at("mcp_servers.pharmallm_cron.timeout")).toBe(900);
    expect(at("mcp_servers.pharmallm_cron.connect_timeout")).toBe(30);
    expect(at("mcp_servers.pharmallm_cron.tools.resources")).toBe(false);
    expect(at("mcp_servers.pharmallm_cron.tools.prompts")).toBe(false);
  });

  it("keeps the tools the scheduled jobs actually call available to the cron server", () => {
    const excluded = at("mcp_servers.pharmallm_cron.tools.exclude") as string[];
    for (const tool of ["run_news_agent", "knowledge_status", "list_knowledge_gaps", "resolve_knowledge_gap", "system_health", "feedback_report"]) {
      expect(excluded).not.toContain(tool);
    }
  });
});

describe("hermes/cron/jobs.json", () => {
  it("defines the four scheduled jobs delivered to Telegram", () => {
    expect(jobs.map((job) => job.name)).toEqual([
      "pharmallm-news-digest",
      "pharmallm-gap-resolution",
      "pharmallm-health-watch",
      "pharmallm-feedback-digest",
    ]);
    // Two health runs a day, not three: every Hermes step is a full cold prefill (~160 s of GPU)
    expect(jobs.map((job) => job.schedule)).toEqual(["0 6 * * *", "0 7 * * *", "0 9,19 * * *", "0 8 * * 1"]);
    for (const job of jobs) {
      expect(job.schedule.split(" ")).toHaveLength(5);
      expect(job.deliver).toBe("telegram");
      expect(job.prompt.length).toBeGreaterThan(40);
      expect(job.prompt).not.toContain("start_reindex");
    }
    expect(jobs[2].prompt).toContain("[SILENT]");
    expect(jobs[1].prompt).toContain("at most 3");
  });

  it("asks for the gap status the detector actually writes and forbids adding knowledge", () => {
    // gap_log rows start as 'triggered'/'skipped', never 'detected' (src/services/gap-detector.ts)
    expect(jobs[1].prompt).toContain("status triggered");
    expect(jobs[1].prompt).not.toContain("status detected");
    expect(jobs[1].prompt).toContain("Do not call add_knowledge");
    // The silent-exit clause must name the same status the job asked for
    expect(jobs[1].prompt).toContain("no triggered gaps");
    expect(jobs[1].prompt).not.toContain("no detected gaps");
  });

  it("asks the feedback digest for both report kinds", () => {
    expect(jobs[3].prompt).toContain("weekly_digest");
    expect(jobs[3].prompt).toContain("low_rated");
  });
});

describe("hermes/SOUL.md", () => {
  it("restricts knowledge-changing tools to explicit requests", () => {
    const soul = readFileSync(join(hermesDir, "SOUL.md"), "utf-8");
    for (const tool of ["add_knowledge", "run_news_agent", "resolve_knowledge_gap", "search_knowledge", "ask_pharmallm"]) {
      expect(soul).toContain(tool);
    }
    expect(soul).toContain("explicitly");
    expect(soul).toContain("Never add knowledge because");
  });
});

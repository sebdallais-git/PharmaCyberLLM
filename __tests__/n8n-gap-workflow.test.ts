import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs pieces of n8n/knowledge_gap_workflow_v2.json against a webhook item
// shaped the way n8n actually delivers it: the POSTed JSON sits under `body`,
// beside headers, params and query. The workflow read the gap fields from the
// top level instead, so on 2026-09-26 it asked the model for queries about
// "undefined" and got back "general web search", "latest news" and
// "trending topics".

interface WorkflowNode {
  name: string;
  parameters: { jsCode?: string; jsonBody?: string };
}

interface Item {
  json: Record<string, unknown>;
}

const WEBHOOK = "Knowledge Gap Webhook";
const workflow = JSON.parse(
  readFileSync(join(process.cwd(), "n8n", "knowledge_gap_workflow_v2.json"), "utf-8"),
) as { nodes: WorkflowNode[] };

function node(name: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`no node named ${name}`);
  return found;
}

const gap = {
  gap_id: 71,
  original_query: "Who is the SAP S/4HANA integrator for Sandoz?",
  search_topic: "Sandoz SAP S/4HANA integrator",
  gemma_response: "The context does not say.",
};

// What n8n's webhook node emits for a POST with that JSON body
const webhookItem: Item = {
  json: { headers: {}, params: {}, query: {}, body: gap, webhookUrl: "", executionMode: "production" },
};

function itemsOf(list: Item[]) {
  return { first: () => list[0], all: () => list, item: list[0] };
}

// Runs a Code node's JavaScript with n8n's `$` and `$input` stood in for
function runCode(name: string, input: Item[] = [], upstream: Record<string, Item[]> = {}): Item[] {
  const code = node(name).parameters.jsCode;
  if (!code) throw new Error(`${name} has no code`);
  const $ = (other: string) => itemsOf(other === WEBHOOK ? [webhookItem] : (upstream[other] ?? []));
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const fn = new Function("$", "$input", "console", code) as (...args: unknown[]) => Item[];
  return fn($, itemsOf(input), quiet);
}

// Evaluates an HTTP Request node's `={{ ... }}` JSON body with $json bound
function evalJsonBody(name: string, $json: Record<string, unknown>): Record<string, unknown> {
  const body = node(name).parameters.jsonBody ?? "";
  const expr = body.replace(/^=\{\{/, "").replace(/\}\}$/, "");
  const fn = new Function("$json", "$env", `return ${expr};`) as (...args: unknown[]) => string;
  return JSON.parse(fn($json, {})) as Record<string, unknown>;
}

describe("knowledge gap workflow reads the gap from the webhook body", () => {
  it("asks the model for search queries about the gap's topic", () => {
    const request = evalJsonBody("Generate Search Queries (Ollama)", webhookItem.json);
    expect(request.prompt).toContain("Sandoz SAP S/4HANA integrator");
    expect(request.prompt).toContain("Who is the SAP S/4HANA integrator for Sandoz?");
    expect(request.prompt).not.toContain("undefined");
  });

  it("carries the topic and question with every parsed query", () => {
    const out = runCode("Parse Search Queries", [{ json: { response: '["q1", "q2"]' } }]);
    expect(out).toHaveLength(2);
    for (const item of out) {
      expect(item.json.search_topic).toBe(gap.search_topic);
      expect(item.json.original_query).toBe(gap.original_query);
    }
  });

  it("falls back to searching the topic itself when the model returns no queries", () => {
    const out = runCode("Parse Search Queries", [{ json: { response: "" } }]);
    expect(out.map((i) => i.json.query)).toEqual([gap.search_topic]);
  });

  it("carries the topic with every deduplicated search result", () => {
    const out = runCode("Deduplicate Results", [
      { json: { results: [{ url: "https://example.test/a", title: "A" }] } },
    ]);
    expect(out[0].json.search_topic).toBe(gap.search_topic);
    expect(out[0].json.original_query).toBe(gap.original_query);
  });

  it("hands Check Gap Resolution the gap id, or the gap can never be marked resolved", () => {
    const [summary] = runCode("Summary & Log", [{ json: {} }], {
      "Deduplicate Results": [{ json: { url: "https://example.test/a" } }],
      "Filter Relevant Only": [{ json: {} }],
    });
    expect(summary.json.gap_id).toBe(71);
    const check = evalJsonBody("Check Gap Resolution", summary.json);
    expect(check).toEqual({ gap_id: 71, original_query: gap.original_query, search_topic: gap.search_topic });
  });

  it("falls back to the topic when query generation fails", () => {
    const [item] = runCode("Ollama Query Error Handler");
    expect(item.json.query).toBe(gap.search_topic);
    expect(item.json.original_query).toBe(gap.original_query);
  });

  it("names the topic when SearXNG fails", () => {
    const [item] = runCode("SearXNG Error Handler");
    expect(item.json.search_topic).toBe(gap.search_topic);
  });

  it("never reads a gap field from the top level of the webhook item", () => {
    // Guards nodes added later: the gap is always under .body
    const topLevel = /\$\('Knowledge Gap Webhook'\)\.(?:first\(\)|item)\.json\.(?!body\b)\w+/;
    for (const n of workflow.nodes) {
      expect(JSON.stringify(n.parameters)).not.toMatch(topLevel);
    }
  });
});

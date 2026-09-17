// Knowledge base tools: search, full RAG answers, adding knowledge, status

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaLLMClient } from "../pharmallm-client.js";
import { runLongTool, runTool } from "./result.js";
import type { ToolLogger, ToolOptions } from "./result.js";

export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

export function registerKnowledgeTools(server: McpServer, client: PharmaLLMClient, log: ToolLogger, options: ToolOptions = {}): void {
  server.registerTool(
    "search_knowledge",
    {
      description:
        "Search PharmaLLM's knowledge base (pharma business, cyber attacks, threat actors, IT vendors, regulations) " +
        "and return the most relevant chunks with their sources. Fast: no LLM call.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for"),
        top_k: z.number().int().min(1).max(20).optional().describe("Number of chunks to return (default 5)"),
      },
    },
    async ({ query, top_k }) =>
      runTool("search_knowledge", log, () => client.post("/api/knowledge/search", { query, topK: top_k ?? 5 }))
  );

  server.registerTool(
    "ask_pharmallm",
    {
      description:
        "Ask PharmaLLM a question and get its full retrieval-augmented answer with sources, the active LLM stack " +
        "and a response_id for feedback. Runs the local 27B model and takes about 1-2 minutes.",
      inputSchema: {
        question: z.string().min(1).describe("The question to answer"),
        web_search: z.boolean().optional().describe("Also search recent news (default false)"),
      },
    },
    async ({ question, web_search }, extra) =>
      runLongTool("ask_pharmallm", log, extra, options, () => client.ask(question, web_search ?? false, ASK_TIMEOUT_MS))
  );

  server.registerTool(
    "add_knowledge",
    {
      description:
        "Add knowledge to PharmaLLM: either text with a source name, or a URL to fetch. " +
        "It is saved as a raw document so it survives reindexing.",
      inputSchema: {
        text: z.string().min(1).optional().describe("Text to add (requires source)"),
        source: z.string().min(1).optional().describe("Source name for the text, e.g. 'analyst-note-2026-09'"),
        url: z.url().optional().describe("URL to fetch and add instead of text"),
      },
    },
    async ({ text, source, url }) =>
      runTool("add_knowledge", log, async () => {
        if (url && text) throw new Error("Provide either text with a source, or a url, not both");
        if (url) return client.post("/api/knowledge/add", { url });
        if (text && source) return client.post("/api/knowledge/ingest-text", { text, source });
        throw new Error("Provide text with a source name, or a url");
      })
  );

  server.registerTool(
    "knowledge_status",
    { description: "Knowledge base size, sources and ChromaDB status for the active stack." },
    async () =>
      runTool("knowledge_status", log, async () => ({
        stats: await client.get("/api/knowledge/stats"),
        status: await client.get("/api/knowledge/status"),
      }))
  );
}

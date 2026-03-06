// PharmaLLM server entry point

import express from "express";
import { join } from "node:path";
import chatRouter from "./api/chat.js";
import knowledgeRouter from "./api/knowledge.js";
import agentRouter from "./api/agent.js";
import { loadIndex, ingestKnowledgeDir, saveIndex } from "./services/knowledge-store.js";
import { runNewsAgent } from "./services/news-agent.js";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const AGENT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.static(join(process.cwd(), "public")));

// Routes API
app.use("/api/chat", chatRouter);
app.use("/api/knowledge", knowledgeRouter);
app.use("/api/agent", agentRouter);

// Start the daily news agent loop
function scheduleNewsAgent(): void {
  // Run immediately on startup (with short delay to let server start)
  setTimeout(() => {
    runNewsAgent().catch((err) => console.error("[News Agent] Error:", err));
  }, 5000);

  // Then run every 24 hours
  setInterval(() => {
    runNewsAgent().catch((err) => console.error("[News Agent] Error:", err));
  }, AGENT_INTERVAL_MS);
}

async function start(): Promise<void> {
  await loadIndex();

  const added = await ingestKnowledgeDir();
  if (added > 0) {
    await saveIndex();
    console.log(`${added} new chunks ingested from files`);
  }

  const HOST = process.env.HOST ?? "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`\nPharmaLLM running on http://${HOST}:${PORT}`);
    console.log(`Make sure Ollama is running (ollama serve)`);
    console.log(`News agent will run every 24 hours\n`);
  });

  scheduleNewsAgent();
}

start().catch(console.error);

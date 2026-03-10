// PharmaLLM server entry point

import express from "express";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chatRouter from "./api/chat.js";
import knowledgeRouter from "./api/knowledge.js";
import agentRouter from "./api/agent.js";
import feedbackRouter from "./api/feedback.js";
import dashboardRouter from "./api/dashboard.js";
import { loadIndex, ingestKnowledgeDir, saveIndex } from "./services/knowledge-store.js";
import { isChromaDBAvailable, getChromaStatus } from "./services/chromadb-store.js";
import { runNewsAgent } from "./services/news-agent.js";
import { initGapDB } from "./services/gap-detector.js";
import { initFeedbackDB } from "./services/feedback-store.js";
import { initRequestLog } from "./services/request-log.js";
import graphRouter from "./api/graph.js";
import { isNeo4jAvailable, getNeo4jStats } from "./services/graph-store.js";

// Prevent the process from crashing on unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

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
app.use("/api/feedback", feedbackRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/graph", graphRouter);
app.use("/api", dashboardRouter); // /api/health
app.use("/dashboard", express.static(join(process.cwd(), "dashboard")));

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
  initGapDB();
  initFeedbackDB();
  initRequestLog();
  await loadIndex();

  const added = await ingestKnowledgeDir();
  if (added > 0) {
    await saveIndex();
    console.log(`${added} new chunks ingested from files`);
  }

  // Check ChromaDB availability
  const chromaOk = await isChromaDBAvailable();
  if (chromaOk) {
    const status = await getChromaStatus();
    console.log(`ChromaDB: connected (${status.totalChunks} chunks, ${status.sources.length} sources)`);
  } else {
    console.log("ChromaDB: not available — RAG will use in-memory store only");
  }

  // Check Neo4j availability
  const neo4jOk = await isNeo4jAvailable();
  if (neo4jOk) {
    const stats = await getNeo4jStats();
    console.log(`Neo4j: connected (${stats.nodeCount} nodes, ${stats.relationshipCount} relationships)`);
  } else {
    console.log("Neo4j: not available — graph RAG will be skipped");
  }

  const HOST = process.env.HOST ?? "0.0.0.0";
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT ?? "3443", 10);
  const CERT_DIR = join(process.cwd(), "certs");

  // Start HTTP server
  app.listen(PORT, HOST, () => {
    console.log(`PharmaLLM running on http://${HOST}:${PORT}`);
  });

  // Start HTTPS server if certs exist (required for iPad mic access)
  const keyPath = join(CERT_DIR, "key.pem");
  const certPath = join(CERT_DIR, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    const httpsOptions = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
    createHttpsServer(httpsOptions, app).listen(HTTPS_PORT, HOST, () => {
      console.log(`PharmaLLM HTTPS running on https://${HOST}:${HTTPS_PORT}`);
    });
  }

  console.log(`Make sure Ollama is running (ollama serve)`);
  console.log(`News agent will run every 24 hours\n`);

  scheduleNewsAgent();
}

start().catch((err) => {
  console.error("[FATAL] Startup failed:", err);
  process.exit(1);
});

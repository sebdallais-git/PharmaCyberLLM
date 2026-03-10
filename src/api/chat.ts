// Routes API pour le chat

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { streamChatWithOllama, listModels, chatWithOllama } from "../services/ollama.js";
import type { OllamaMessage, TokenStats } from "../services/ollama.js";
import { searchKnowledge } from "../services/knowledge-store.js";
import { searchChromaDB, isChromaDBAvailable } from "../services/chromadb-store.js";
import type { ChromaQueryResult } from "../services/chromadb-store.js";
import { searchWeb } from "../services/web-search.js";
import { handleGapDetection } from "../services/gap-detector.js";
import { createResponseEntry } from "../services/response-cache.js";
import { logRequest, logChromaDBMiss } from "../services/request-log.js";
import { isNeo4jAvailable, queryGraphForChat } from "../services/graph-store.js";

const router = Router();

// Extract key terms from a natural-language question for web search
// Google News is strict — extra words can kill results, so we aggressively
// filter to keep only the meaningful nouns and proper nouns.
function extractSearchQuery(message: string): string {
  const dropWords = new Set([
    // question words & pronouns
    "what", "why", "how", "when", "where", "who", "which", "whose",
    "is", "are", "was", "were", "am", "be", "been", "being",
    "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
    "has", "have", "had", "shall",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its",
    "they", "them", "their", "this", "that", "these", "those",
    // prepositions & conjunctions
    "the", "a", "an", "of", "in", "for", "on", "with", "to", "and", "or",
    "not", "at", "by", "from", "as", "into", "but", "so", "if", "then",
    "there", "here", "up", "out", "about", "over", "after", "before",
    // common verbs that hurt search specificity
    "tell", "know", "think", "explain", "describe", "talk", "say", "said",
    "get", "got", "make", "made", "take", "took", "give", "go", "going",
    "come", "came", "see", "look", "want", "need", "use", "used", "try",
    "keep", "let", "seem", "show", "hear", "believe", "happen", "happen",
    "mean", "means", "brags", "brag", "bragging", "claim", "claims",
    "says", "says", "discuss", "mention", "mentioned", "called",
    // fillers
    "please", "thanks", "really", "very", "just", "also", "recently",
    "actually", "basically", "currently", "new", "latest", "much",
  ]);

  const keywords = message
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !dropWords.has(w.toLowerCase()));

  // Limit to 5 terms max for search precision
  return keywords.slice(0, 5).join(" ");
}

// Extract entity names from a question for graph search
async function extractGraphKeywords(message: string): Promise<string[]> {
  try {
    const response = await chatWithOllama([
      {
        role: "system",
        content: "Extract the key entity names (company names, drug names, vendor names, threat actor names, country names, technology names) from this question. Return ONLY a JSON array of strings, nothing else. Example: [\"Pfizer\", \"Keytruda\", \"LockBit\"]",
      },
      { role: "user", content: message },
    ], undefined, { temperature: 0, num_ctx: 2048 });

    const match = response.match(/\[[\s\S]*?\]/);
    if (match) {
      const keywords = JSON.parse(match[0]) as string[];
      return keywords.filter((k) => typeof k === "string" && k.length > 1).slice(0, 5);
    }
  } catch {
    // Fail silently — graph keywords are optional
  }
  return [];
}

// Session-level toggle for naming companies in cyber incident responses
let nameCompanies = false;

const BASE_SYSTEM_PROMPT = `You are PharmaBot, an expert assistant in the pharmaceutical industry.
You answer questions on the following topics:
- Pharma business: mergers, acquisitions, commercial strategies, pipelines, pricing
- Pharma science: mechanisms of action, clinical trials, pharmacology, drug formulation
- Pharma news: FDA/EMA approvals, product launches, regulation
- Drug pipeline: Phase 3 candidates, peak sales estimates, market value forecasts, revenue projections
- Cyber threats: ransomware, data breaches, IP theft, manufacturing shutdowns, market impact
- Manufacturing: top pharma plants worldwide, facility investment value, production capacity, downtime costs per hour/day, batch loss values, geographic concentration risk (Basel, Ireland, RTP, Singapore)
- IT vendors: Dell, Pure Storage, NetApp, HPE, NVIDIA, VAST, WEKA, CrowdStrike, Splunk, SAP, ServiceNow, Snowflake, Databricks

Rules:
- Use the following context to answer the user's question.
- If the context doesn't contain relevant information, say so honestly and answer based on your general knowledge, clearly stating that you're not confident in the answer.
- When the context contains relevant data (tables, lists, numbers, costs, facility names), use it directly and specifically in your answer.
- Cite sources when using the provided context.
- Respond in the same language as the question.`;

const NAMES_ON_PROMPT = `
- When discussing cyber incidents, data breaches, ransomware attacks, or security events, ALWAYS name the specific companies, organizations, and threat actors involved if this information is publicly known. Include dates, attack vectors, and financial impact where available. Do NOT anonymize or redact company names — the user wants full transparency on publicly reported incidents.`;

const NAMES_OFF_PROMPT = `
- When discussing cyber incidents, you may reference companies only in general terms without naming specific victims unless the user explicitly asks.`;

function getSystemPrompt(): string {
  return BASE_SYSTEM_PROMPT + (nameCompanies ? NAMES_ON_PROMPT : NAMES_OFF_PROMPT);
}

const GAP_DISCLAIMER = "\n\n---\n*I'm not fully confident in this answer. I'm researching this topic now and should know more soon.*";

// POST /api/chat - Send a message and receive a streaming response
router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { message, history, model, webSearch } = req.body as {
    message: string;
    history?: OllamaMessage[];
    model?: string;
    webSearch?: boolean;
  };

  if (!message) {
    res.status(400).json({ error: "The 'message' field is required" });
    return;
  }

  // Handle /names toggle command
  const trimmed = message.trim().toLowerCase();
  if (trimmed === "/names") {
    nameCompanies = !nameCompanies;
    const state = nameCompanies ? "ON" : "OFF";
    const detail = nameCompanies
      ? "I will name specific companies in cyber incident responses."
      : "I will keep cyber incident responses generic.";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`data: ${JSON.stringify({ token: `Company names are now **${state}**. ${detail}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const requestStart = Date.now();

  // SSE streaming configuration — set up early so we can send reasoning steps
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendReasoning = (text: string, sources?: string[]) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ reasoning: text, sources: sources ?? [] })}\n\n`);
    }
  };

  // Search knowledge base — ChromaDB (primary) + in-memory (fallback)
  let contextBlock = "";
  let chunkIds: string[] = [];
  let hadRagContext = false;
  let chromaMissReason = "";

  sendReasoning("Searching knowledge base...");

  try {
    const chromaAvailable = await isChromaDBAvailable();
    if (chromaAvailable) {
      const chromaResults = await searchChromaDB(message, 5);
      if (chromaResults.length > 0) {
        contextBlock = "\n\nRelevant context from the knowledge base:\n" +
          chromaResults
            .map((r: ChromaQueryResult) => `[Source: ${String(r.metadata.source ?? "unknown")}]\n${r.document}`)
            .join("\n\n---\n\n");
        chunkIds = chromaResults.map((r: ChromaQueryResult) => r.id);
        hadRagContext = true;
        const sourceNames = chromaResults.map((r: ChromaQueryResult) => String(r.metadata.source ?? "unknown"));
        sendReasoning(`Found ${chromaResults.length} relevant chunks from ChromaDB`, sourceNames);
        console.log(`[RAG] ChromaDB returned ${chromaResults.length} chunks`);
      } else {
        chromaMissReason = "no_results";
        sendReasoning("No matches in ChromaDB, trying in-memory store...");
      }
    } else {
      chromaMissReason = "unavailable";
      sendReasoning("ChromaDB unavailable, using in-memory store...");
    }
  } catch (err) {
    chromaMissReason = "error";
    sendReasoning("ChromaDB search failed, falling back to in-memory store...");
    console.error("[RAG] ChromaDB search failed, falling back to in-memory:", err);
  }

  // Fallback to in-memory knowledge store if ChromaDB returned nothing
  let hadInmemoryFallback = false;
  if (!contextBlock) {
    const relevantChunks = await searchKnowledge(message, 8);
    if (relevantChunks.length > 0) {
      contextBlock = "\n\nRelevant context from the knowledge base:\n" +
        relevantChunks
          .map((c) => `[Source: ${c.source}]\n${c.content}`)
          .join("\n\n---\n\n");
      chunkIds = relevantChunks.map((c) => c.source);
      hadRagContext = true;
      hadInmemoryFallback = true;
      const sourceNames = [...new Set(relevantChunks.map((c) => c.source))];
      sendReasoning(`Found ${relevantChunks.length} chunks from knowledge base`, sourceNames);
      console.log(`[RAG] In-memory store returned ${relevantChunks.length} chunks`);
    } else {
      sendReasoning("No relevant knowledge base context found");
    }
  }

  // Log ChromaDB miss for future KB growth
  if (chromaMissReason) {
    setImmediate(() => {
      logChromaDBMiss({ query: message, reason: chromaMissReason, hadInmemoryFallback });
    });
  }

  // Graph search + web search in parallel
  let graphContext = "";

  const graphSearchPromise = (async () => {
    try {
      const neo4jAvailable = await isNeo4jAvailable();
      if (!neo4jAvailable) return;

      sendReasoning("Searching knowledge graph...");
      const keywords = await extractGraphKeywords(message);

      if (keywords.length > 0) {
        graphContext = await queryGraphForChat(keywords);
        if (graphContext) {
          const entityNames = keywords.filter((k) => graphContext.toLowerCase().includes(k.toLowerCase()));
          sendReasoning(
            `Found ${entityNames.length} entities in knowledge graph`,
            entityNames
          );
        } else {
          sendReasoning("No graph matches found");
        }
      }
    } catch {
      sendReasoning("Knowledge graph unavailable, skipping...");
    }
  })();

  const webSearchPromise = (async () => {
    if (webSearch === false) return;
    try {
      const searchQuery = extractSearchQuery(message);
      sendReasoning(`Searching the web for: "${searchQuery}"...`);
      const webResults = await searchWeb(searchQuery, 5);
      if (webResults.length > 0) {
        contextBlock += "\n\nRecent news from web search:\n" +
          webResults
            .map((r) => `[${r.title}] (${r.date})\n${r.snippet}`)
            .join("\n\n---\n\n");
        const webSources = webResults.map((r) => r.title);
        sendReasoning(`Found ${webResults.length} web results`, webSources);
      } else {
        sendReasoning("No relevant web results found");
      }
    } catch {
      sendReasoning("Web search unavailable, skipping...");
    }
  })();

  await Promise.all([graphSearchPromise, webSearchPromise]);

  if (graphContext) {
    contextBlock += "\n\n" + graphContext;
  }

  sendReasoning(`Generating response with ${model ?? "mistral-small:24b"}...`);

  const messages: OllamaMessage[] = [
    { role: "system", content: getSystemPrompt() + contextBlock },
    ...(history ?? []),
    { role: "user", content: message },
  ];

  try {
    // Collect the full response during streaming
    let fullResponse = "";
    const statsCollector: { result?: TokenStats } = {};

    for await (const token of streamChatWithOllama(messages, model, statsCollector)) {
      fullResponse += token;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    // Confidence check after the full response
    const gapDetected = await handleGapDetection(message, fullResponse, model);

    if (gapDetected) {
      res.write(`data: ${JSON.stringify({ token: GAP_DISCLAIMER })}\n\n`);
      res.write(`data: ${JSON.stringify({ gap_detected: true })}\n\n`);
      console.log(`[Gap Detector] Knowledge gap detected for: "${message.slice(0, 80)}..."`);
    }

    // Store response metadata and generate response_id for feedback
    const responseId = createResponseEntry(
      message,
      fullResponse,
      chunkIds,
      hadRagContext,
      model ?? "mistral-small:24b"
    );

    // Log request async (don't block response)
    const responseTimeMs = Date.now() - requestStart;
    setImmediate(() => {
      logRequest({
        query: message,
        responseTimeMs,
        hadRagContext,
        wasConfident: !gapDetected,
        chunksUsedCount: chunkIds.length,
        responseLength: fullResponse.length,
      });
    });

    res.write(`data: ${JSON.stringify({ done: true, response_id: responseId, tokenStats: statsCollector.result ?? null })}\n\n`);
    res.end();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
    res.end();
  }
});

// GET /api/chat/models - List available Ollama models
router.get("/models", async (_req: Request, res: Response): Promise<void> => {
  try {
    const models = await listModels();
    res.json({ models });
  } catch {
    res.status(503).json({
      error: "Cannot reach Ollama. Make sure it is running.",
      models: [],
    });
  }
});

// POST /api/chat/transcribe - Transcribe audio via whisper.cpp
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const WHISPER_BIN = join(process.cwd(), "node_modules", "whisper-node", "lib", "whisper.cpp", "main");
const WHISPER_MODEL = join(process.cwd(), "node_modules", "whisper-node", "lib", "whisper.cpp", "models", "ggml-base.en.bin");
const TMP_DIR = join(process.cwd(), "data", "tmp");

router.post("/transcribe", audioUpload.single("audio"), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  const id = randomUUID();
  // Determine extension from original filename (webm, mp4, ogg, etc.)
  const origName = req.file.originalname ?? "audio.webm";
  const ext = origName.split(".").pop() ?? "webm";
  const inputPath = join(TMP_DIR, `${id}.${ext}`);
  const wavPath = join(TMP_DIR, `${id}.wav`);

  try {
    await mkdir(TMP_DIR, { recursive: true });
    await writeFile(inputPath, req.file.buffer);
    console.log(`[Transcribe] Received ${req.file.size} bytes (${ext}), saved to ${inputPath}`);

    // Convert any audio format to 16kHz mono WAV using ffmpeg
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", ["-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y"],
        { timeout: 15000 },
        (err, _stdout, stderr) => {
          if (err) {
            console.error("[Transcribe] ffmpeg error:", stderr);
            reject(new Error("Audio conversion failed: " + (stderr || err.message)));
            return;
          }
          resolve();
        }
      );
    });

    // Run whisper.cpp
    const transcript = await new Promise<string>((resolve, reject) => {
      execFile(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", wavPath, "-nt", "-l", "en"],
        { timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          // whisper.cpp outputs text lines with timestamps — extract text only
          const text = stdout
            .split("\n")
            .map((line) => line.replace(/^\[.*?\]\s*/, "").trim())
            .filter(Boolean)
            .join(" ")
            .trim();
          resolve(text);
        }
      );
    });

    res.json({ text: transcript });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Transcription failed";
    console.error("[Transcribe]", msg);
    res.status(500).json({ error: msg });
  } finally {
    // Cleanup temp files
    unlink(inputPath).catch(() => {});
    unlink(wavPath).catch(() => {});
  }
});

export default router;

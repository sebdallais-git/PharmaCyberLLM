// Routes API pour le chat

import { Router } from "express";
import type { Request, Response } from "express";
import { streamChatWithOllama, listModels } from "../services/ollama.js";
import type { OllamaMessage } from "../services/ollama.js";
import { searchKnowledge } from "../services/knowledge-store.js";
import { searchChromaDB, isChromaDBAvailable } from "../services/chromadb-store.js";
import type { ChromaQueryResult } from "../services/chromadb-store.js";
import { searchWeb } from "../services/web-search.js";
import { handleGapDetection } from "../services/gap-detector.js";

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

const SYSTEM_PROMPT = `You are PharmaBot, an expert assistant in the pharmaceutical industry.
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

const GAP_DISCLAIMER = "\n\n---\n*I'm not fully confident in this answer. I'm researching this topic now and should know more soon.*";

// POST /api/chat - Envoie un message et reçoit une réponse en streaming
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

  // Search knowledge base — ChromaDB (primary) + in-memory (fallback)
  let contextBlock = "";
  try {
    const chromaAvailable = await isChromaDBAvailable();
    if (chromaAvailable) {
      const chromaResults = await searchChromaDB(message, 5);
      if (chromaResults.length > 0) {
        contextBlock = "\n\nRelevant context from the knowledge base:\n" +
          chromaResults
            .map((r: ChromaQueryResult) => `[Source: ${String(r.metadata.source ?? "unknown")}]\n${r.document}`)
            .join("\n\n---\n\n");
        console.log(`[RAG] ChromaDB returned ${chromaResults.length} chunks`);
      }
    }
  } catch (err) {
    console.error("[RAG] ChromaDB search failed, falling back to in-memory:", err);
  }

  // Fallback to in-memory knowledge store if ChromaDB returned nothing
  if (!contextBlock) {
    const relevantChunks = await searchKnowledge(message, 8);
    if (relevantChunks.length > 0) {
      contextBlock = "\n\nRelevant context from the knowledge base:\n" +
        relevantChunks
          .map((c) => `[Source: ${c.source}]\n${c.content}`)
          .join("\n\n---\n\n");
      console.log(`[RAG] In-memory store returned ${relevantChunks.length} chunks`);
    }
  }

  // Web search if enabled
  if (webSearch !== false) {
    try {
      const searchQuery = extractSearchQuery(message);
      const webResults = await searchWeb(searchQuery, 5);
      if (webResults.length > 0) {
        contextBlock += "\n\nRecent news from web search:\n" +
          webResults
            .map((r) => `[${r.title}] (${r.date})\n${r.snippet}`)
            .join("\n\n---\n\n");
      }
    } catch {
      // Web search is best-effort, don't block the response
    }
  }

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + contextBlock },
    ...(history ?? []),
    { role: "user", content: message },
  ];

  // Configuration du streaming SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    // Collecter la réponse complète pendant le streaming
    let fullResponse = "";

    for await (const token of streamChatWithOllama(messages, model)) {
      fullResponse += token;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    // Vérification de confiance après la réponse complète
    const gapDetected = await handleGapDetection(message, fullResponse, model);

    if (gapDetected) {
      // Envoyer le disclaimer comme tokens supplémentaires
      res.write(`data: ${JSON.stringify({ token: GAP_DISCLAIMER })}\n\n`);
      res.write(`data: ${JSON.stringify({ gap_detected: true })}\n\n`);
      console.log(`[Gap Detector] Knowledge gap detected for: "${message.slice(0, 80)}..."`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Erreur inconnue";
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
    res.end();
  }
});

// GET /api/chat/models - Liste les modèles Ollama disponibles
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

export default router;

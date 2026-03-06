// Automated news agent - scrubs the web daily for pharma and cyber threat news

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestText, saveIndex, getStats } from "./knowledge-store.js";

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");
const AGENT_STATE_PATH = join(KNOWLEDGE_DIR, ".agent-state.json");

interface NewsItem {
  title: string;
  date: string;
  source: string;
  link: string;
}

interface AgentState {
  lastRun: string;
  seenTitles: string[];
}

// Topics to monitor - pharma business, science, news, cyber threats, and IT vendors
const SEARCH_TOPICS = [
  // Pharma business
  "pharmaceutical merger acquisition",
  "pharma FDA approval",
  "pharma EMA approval",
  "pharmaceutical pipeline clinical trial results",
  "pharma drug launch",
  "pharma patent expiration biosimilar",
  "pharmaceutical pricing regulation",
  "pharma company earnings revenue",
  // Pharma science
  "drug discovery breakthrough",
  "clinical trial results pharmaceutical",
  "mRNA therapy pharmaceutical",
  "CRISPR gene therapy approval",
  "antibody drug conjugate ADC",
  "GLP-1 obesity diabetes pharmaceutical",
  "AI drug discovery pharmaceutical",
  "cell gene therapy pharmaceutical",
  // Cyber threats in pharma
  "pharmaceutical cyber attack",
  "pharma ransomware breach",
  "healthcare data breach pharmaceutical",
  "pharmaceutical cybersecurity threat",
  "pharma hack data stolen",
  "hospital pharmacy ransomware",
  "pharmaceutical supply chain cyber attack",
  "FDA cybersecurity pharmaceutical",
  // Storage and cyber recovery vendors
  "Dell PowerProtect cyber recovery ransomware",
  "Pure Storage SafeMode ransomware healthcare",
  "NetApp ONTAP ransomware protection",
  "HPE Zerto cyber recovery",
  "VAST Data cybersecurity data protection",
  "WEKA data platform life sciences",
  // NVIDIA and AI infrastructure
  "NVIDIA Morpheus cybersecurity",
  "NVIDIA Clara BioNeMo drug discovery",
  "NVIDIA DGX pharmaceutical AI",
  // SIEM and security operations
  "Splunk SIEM healthcare pharmaceutical",
  "Microsoft Sentinel healthcare cybersecurity",
  "CrowdStrike pharmaceutical healthcare",
  "Palo Alto Cortex XSIAM cybersecurity",
  // Security data platforms
  "Snowflake cybersecurity data lake",
  "Databricks cybersecurity analytics",
  // IT operations and compliance
  "ServiceNow SecOps vulnerability pharmaceutical",
  "ServiceNow healthcare cybersecurity",
  // SAP security
  "SAP security vulnerability pharmaceutical",
  "SAP ERP cyber attack",
  "SAP zero-day exploit",
  // Endpoint and identity security
  "CrowdStrike Falcon endpoint pharmaceutical",
  "SailPoint identity governance healthcare pharmaceutical",
  "SentinelOne endpoint pharmaceutical healthcare",
  "Zscaler zero trust pharmaceutical healthcare",
  // Phase 3 pipeline and clinical trials
  "phase 3 clinical trial results pharmaceutical",
  "FDA drug approval 2026",
  "obesity drug GLP-1 retatrutide orforglipron phase 3",
  "oncology phase 3 trial results breast cancer lung cancer",
  "Alzheimer phase 3 trial results",
  "gene therapy CRISPR CAR-T FDA approval",
  "blockbuster drug pipeline phase 3 readout",
];

async function fetchGoogleNewsRSS(query: string): Promise<NewsItem[]> {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });

  try {
    const response = await fetch(
      `https://news.google.com/rss/search?${params}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) return [];

    const xml = await response.text();
    const items: NewsItem[] = [];

    const xmlItems = xml.split("<item>");
    for (let i = 1; i < xmlItems.length && items.length < 5; i++) {
      const item = xmlItems[i];
      const title = extractTag(item, "title");
      const pubDate = extractTag(item, "pubDate");
      const link = extractTag(item, "link");

      // Extract source from title (format: "Title - Source Name")
      const parts = title.split(" - ");
      const source = parts.length > 1 ? parts.pop()! : "Unknown";
      const cleanTitle = parts.join(" - ");

      if (cleanTitle) {
        items.push({
          title: decodeEntities(cleanTitle),
          date: pubDate ? formatDate(pubDate) : new Date().toISOString().split("T")[0],
          source: decodeEntities(source),
          link,
        });
      }
    }

    return items;
  } catch {
    return [];
  }
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  if (match) return match[1].trim();
  const simpleRegex = new RegExp(`<${tag}>([^<]*)`);
  const simpleMatch = xml.match(simpleRegex);
  return simpleMatch ? simpleMatch[1].trim() : "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toISOString().split("T")[0];
  } catch {
    return dateStr;
  }
}

async function loadAgentState(): Promise<AgentState> {
  try {
    const data = await readFile(AGENT_STATE_PATH, "utf-8");
    return JSON.parse(data) as AgentState;
  } catch {
    return { lastRun: "", seenTitles: [] };
  }
}

async function saveAgentState(state: AgentState): Promise<void> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  await writeFile(AGENT_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export async function runNewsAgent(): Promise<{ newArticles: number; topics: number }> {
  console.log("[News Agent] Starting daily news scrub...");

  const state = await loadAgentState();
  const seenSet = new Set(state.seenTitles);
  let newArticles = 0;
  let topicsProcessed = 0;

  for (const topic of SEARCH_TOPICS) {
    const items = await fetchGoogleNewsRSS(topic);
    topicsProcessed++;

    for (const item of items) {
      // Skip duplicates
      if (seenSet.has(item.title)) continue;
      seenSet.add(item.title);

      // Format as knowledge text
      const text = `[${item.date}] ${item.title}\nSource: ${item.source}\nURL: ${item.link}`;
      const sourceName = `news-${item.date}`;

      ingestText(text, sourceName);
      newArticles++;
    }

    // Small delay between requests to be polite
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (newArticles > 0) {
    await saveIndex();
  }

  // Keep only last 2000 seen titles to avoid unbounded growth
  const seenArray = [...seenSet];
  state.seenTitles = seenArray.slice(-2000);
  state.lastRun = new Date().toISOString();
  await saveAgentState(state);

  const stats = getStats();
  console.log(`[News Agent] Done. ${newArticles} new articles ingested. Total chunks: ${stats.totalChunks}`);
  return { newArticles, topics: topicsProcessed };
}

export function getAgentTopics(): string[] {
  return [...SEARCH_TOPICS];
}

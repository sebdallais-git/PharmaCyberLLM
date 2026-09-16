// Automated news agent - scrubs the web daily for pharma and cyber threat news

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestText, saveIndex, getStats } from "./knowledge-store.js";
import { addToChromaDB, isChromaDBAvailable } from "./chromadb-store.js";
import { saveRawDocument } from "./raw-documents.js";
import { isNeo4jAvailable, writeEntities } from "./graph-store.js";
import type { GraphEntity, GraphRelationship } from "./graph-store.js";
import { chatWithOllama } from "./ollama.js";

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
  "Everpure SafeMode ransomware healthcare",
  "NetApp ONTAP ransomware protection",
  "HPE Zerto cyber recovery",
  "VAST Data cybersecurity data protection",
  "WEKA data platform life sciences",
  // NVIDIA and AI infrastructure
  "NVIDIA Morpheus cybersecurity",
  "NVIDIA Clara BioNeMo drug discovery",
  "NVIDIA DGX pharmaceutical AI",
  "NVIDIA H100 H200 Blackwell AI training life sciences",
  "NVIDIA NIM inference microservices healthcare",
  "NVIDIA digital twin molecular simulation drug discovery",
  "NVIDIA partnership pharmaceutical AI research",
  "GPU cluster HPC pharmaceutical drug discovery",
  "NVIDIA AI Enterprise healthcare deployment",
  "NVIDIA Parabricks genomics sequencing pharmaceutical",
  // SIEM and security operations
  "Splunk SIEM healthcare pharmaceutical",
  "Microsoft Sentinel healthcare cybersecurity",
  "CrowdStrike pharmaceutical healthcare",
  "Palo Alto Cortex XSIAM cybersecurity",
  "QRadar SIEM healthcare pharmaceutical threat",
  "Google Chronicle SecOps pharmaceutical healthcare",
  "Exabeam SIEM healthcare pharmaceutical",
  "SOC automation SOAR pharmaceutical healthcare",
  // Security data platforms
  "Snowflake cybersecurity data lake",
  "Databricks cybersecurity analytics",
  "Snowflake healthcare data sharing pharmaceutical compliance",
  "Databricks lakehouse life sciences pharmaceutical",
  "Elastic Security SIEM pharmaceutical healthcare",
  "BigQuery healthcare pharmaceutical security analytics",
  "data mesh pharmaceutical cybersecurity threat detection",
  "security data lake threat intelligence healthcare",
  // IT operations and compliance
  "ServiceNow SecOps vulnerability pharmaceutical",
  "ServiceNow healthcare cybersecurity",
  "GxP compliance pharmaceutical IT validation",
  "21 CFR Part 11 electronic records pharmaceutical",
  "HIPAA compliance pharmaceutical data protection",
  "pharmaceutical IT audit regulatory inspection",
  "cloud migration pharmaceutical compliance GxP",
  "DevSecOps pharmaceutical life sciences CI CD",
  "ITSM IT service management pharmaceutical healthcare",
  "IT infrastructure modernization pharmaceutical",
  // SAP security
  "SAP security vulnerability pharmaceutical",
  "SAP ERP cyber attack",
  "SAP zero-day exploit",
  "SAP S/4HANA migration pharmaceutical security",
  "SAP GRC governance risk compliance pharmaceutical",
  "SAP HANA database security vulnerability patch",
  "SAP cloud security BTP pharmaceutical life sciences",
  // Endpoint and identity security
  "CrowdStrike Falcon endpoint pharmaceutical",
  "SailPoint identity governance healthcare pharmaceutical",
  "SentinelOne endpoint pharmaceutical healthcare",
  "Zscaler zero trust pharmaceutical healthcare",
  "Okta identity breach pharmaceutical healthcare",
  "Microsoft Entra identity governance pharmaceutical",
  "Tanium endpoint visibility pharmaceutical",
  "Proofpoint email security pharmaceutical phishing",
  // Shadow IT and shadow AI
  "shadow IT pharmaceutical healthcare risk",
  "shadow AI generative AI unauthorized pharmaceutical",
  "ChatGPT data leak pharmaceutical employee",
  "unapproved AI tool pharmaceutical compliance risk",
  "shadow SaaS pharmaceutical healthcare security",
  "BYOD unauthorized app pharmaceutical data",
  "AI governance policy pharmaceutical life sciences",
  "generative AI sensitive data exposure pharmaceutical",
  "copilot AI code leak pharmaceutical intellectual property",
  "unsanctioned cloud service pharmaceutical data risk",
  "LLM prompt injection pharmaceutical data exfiltration",
  "AI model training pharmaceutical proprietary data",
  // Pharma manufacturing security and incidents
  "pharmaceutical manufacturing cyber attack OT",
  "pharma SCADA ICS vulnerability manufacturing",
  "pharmaceutical production line ransomware shutdown",
  "drug manufacturing supply chain disruption cyber",
  "pharmaceutical GMP manufacturing breach",
  "pharma cold chain logistics cyber attack",
  "pharmaceutical factory OT IT convergence security",
  "pharma manufacturing IoT vulnerability sensor",
  "pharmaceutical quality control system hack",
  "drug counterfeiting supply chain integrity pharmaceutical",
  // Hacker groups and malware targeting pharma
  "LockBit ransomware pharmaceutical healthcare",
  "BlackCat ALPHV ransomware pharmaceutical",
  "Cl0p MOVEit pharmaceutical supply chain",
  "Black Basta ransomware healthcare pharmaceutical",
  "RansomHub ransomware pharmaceutical",
  "APT29 Cozy Bear pharmaceutical vaccine espionage",
  "APT41 Winnti pharmaceutical intellectual property theft",
  "Lazarus Group pharmaceutical biotech cyber attack",
  "nation state espionage pharmaceutical trade secret",
  "ransomware gang pharmaceutical biotech attack",
  // Patient data breaches and darknet
  "patient data breach pharmaceutical healthcare",
  "patient health records stolen darknet",
  "PHI protected health information breach pharmaceutical",
  "medical records dark web sale price",
  "patient data exfiltration pharmaceutical",
  "healthcare data leak patient privacy",
  "pharmaceutical clinical trial data breach",
  "patient data GDPR violation pharmaceutical",
  "stolen medical records identity fraud",
  "healthcare data broker darknet marketplace",
  // Third-party and vendor risk
  "third party vendor breach pharmaceutical CRO CMO",
  "pharmaceutical outsourcing cybersecurity risk",
  "CRO clinical research organization data breach",
  "CMO contract manufacturing cyber attack pharmaceutical",
  "pharmaceutical supply chain vendor risk management",
  "third party risk assessment pharmaceutical healthcare",
  "managed service provider breach pharmaceutical",
  "pharmaceutical cloud provider security incident",
  // Insider threats and corporate espionage
  "insider threat pharmaceutical trade secret theft",
  "pharmaceutical employee IP theft departing scientist",
  "corporate espionage pharmaceutical biotech",
  "pharmaceutical whistleblower data leak",
  "disgruntled employee sabotage pharmaceutical",
  "pharmaceutical competitive intelligence espionage",
  "biotech startup IP theft insider",
  "pharmaceutical research data exfiltration insider",
  // Cloud security
  "AWS Azure GCP misconfiguration pharmaceutical data leak",
  "cloud security posture pharmaceutical healthcare CSPM",
  "S3 bucket exposure pharmaceutical clinical trial data",
  "pharmaceutical cloud migration security risk",
  "healthcare pharmaceutical cloud compliance HITRUST",
  "multi-cloud security pharmaceutical life sciences",
  "container kubernetes security pharmaceutical",
  "pharmaceutical SaaS security cloud access broker CASB",
  // Regulatory and government cyber mandates
  "NIS2 directive pharmaceutical cybersecurity EU",
  "SEC cyber disclosure rule pharmaceutical",
  "FDA premarket cybersecurity guidance medical device",
  "pharmaceutical cybersecurity regulation government mandate",
  "DORA digital operational resilience pharmaceutical",
  "pharmaceutical cyber incident reporting requirement",
  "EU pharmaceutical cybersecurity compliance regulation",
  "CISA healthcare pharmaceutical cybersecurity advisory",
  // Medical devices and connected health
  "infusion pump cybersecurity vulnerability pharmaceutical",
  "connected drug delivery device security",
  "IoT medical device vulnerability pharmaceutical",
  "pharmaceutical wearable device data security",
  "smart inhaler connected health cybersecurity",
  "medical device firmware vulnerability pharmaceutical",
  "drug delivery system hack cyber attack",
  // Cyber insurance
  "cyber insurance pharmaceutical healthcare premium",
  "cyber insurance coverage denial pharmaceutical breach",
  "pharmaceutical cyber insurance policy exclusion",
  "healthcare cyber insurance claim ransomware",
  "cyber insurance underwriting pharmaceutical risk",
  // Disinformation and reputation
  "deepfake pharmaceutical executive fraud",
  "anti-vaccine disinformation campaign pharmaceutical",
  "pharmaceutical stock manipulation social media",
  "pharma reputation attack disinformation",
  "fake pharmaceutical website phishing brand abuse",
  // Post-quantum cryptography
  "post-quantum cryptography pharmaceutical IP protection",
  "harvest now decrypt later pharmaceutical trade secret",
  "quantum computing threat pharmaceutical encryption",
  "NIST post-quantum standard pharmaceutical",
  // Geopolitical API sourcing risks
  "China API active pharmaceutical ingredient supply chain risk",
  "India pharmaceutical manufacturing supply chain disruption",
  "geopolitical pharmaceutical supply chain reshoring",
  "pharmaceutical raw material sourcing geopolitical tension",
  "API supply chain diversification pharmaceutical",
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

async function extractNewsEntities(texts: string[]): Promise<void> {
  try {
    const neo4jOk = await isNeo4jAvailable();
    if (!neo4jOk) return;

    // Batch all new articles into a single extraction call
    const combined = texts.slice(0, 50).join("\n\n---\n\n").slice(0, 12000);

    const extractionPrompt = `You are an entity extraction engine. Extract entities and relationships from these news items.
Entity types: Company, Subsidiary, Drug, TherapeuticArea, ManufacturingSite, Country, RegulatoryBody, Regulation, ThreatActor, Attack, AttackVector, Vendor, Product, Technology
Return ONLY valid JSON: {"entities": [{"type": "...", "name": "...", "properties": {...}}], "relationships": [{"from": "...", "fromType": "...", "to": "...", "toType": "...", "type": "...", "properties": {...}}]}`;

    const response = await chatWithOllama(
      [
        { role: "system", content: extractionPrompt },
        { role: "user", content: combined },
      ],
      undefined,
      { temperature: 0.1 }
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]) as {
      entities?: Array<{ type: string; name: string; properties: Record<string, unknown> }>;
      relationships?: Array<{
        from: string; fromType: string; to: string; toType: string;
        type: string; properties: Record<string, unknown>;
      }>;
    };

    const entities: GraphEntity[] = (data.entities ?? []).map((e) => ({
      type: e.type,
      name: e.name,
      properties: Object.fromEntries(
        Object.entries(e.properties ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")
      ),
    }));

    const relationships: GraphRelationship[] = (data.relationships ?? []).map((r) => ({
      from: r.from,
      fromType: r.fromType,
      to: r.to,
      toType: r.toType,
      type: r.type.replace(/\s+/g, "_").toUpperCase(),
      properties: Object.fromEntries(
        Object.entries(r.properties ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")
      ),
    }));

    if (entities.length > 0 || relationships.length > 0) {
      const result = await writeEntities(entities, relationships);
      console.log(`[News Agent] Graph: ${result.nodesProcessed} nodes, ${result.relsProcessed} rels from ${texts.length} articles`);
    }
  } catch (err) {
    console.error("[News Agent] Graph entity extraction failed:", err instanceof Error ? err.message : err);
  }
}

export async function runNewsAgent(): Promise<{ newArticles: number; topics: number }> {
  console.log("[News Agent] Starting daily news scrub...");

  const state = await loadAgentState();
  const seenSet = new Set(state.seenTitles);
  let newArticles = 0;
  let topicsProcessed = 0;
  const newTexts: string[] = [];

  const chromaOk = await isChromaDBAvailable().catch(() => false);

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

      // 1. Raw document: lets every stack's index be rebuilt from disk
      await saveRawDocument(
        sourceName,
        text,
        { type: "news", link: item.link, title: item.title },
        { key: item.link || text }
      );

      // 2. In-memory store (awaited so saveIndex below includes the embedding)
      await ingestText(text, sourceName);

      // 3. ChromaDB (persistent vector store)
      if (chromaOk) {
        try {
          await addToChromaDB([text], [{ source: sourceName }]);
        } catch (err) {
          console.error(`[News Agent] ChromaDB ingest failed:`, err instanceof Error ? err.message : err);
        }
      }

      newTexts.push(text);
      newArticles++;
    }

    // Small delay between requests to be polite
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (newArticles > 0) {
    await saveIndex();
  }

  // 4. Neo4j graph extraction (batched, non-blocking)
  if (newTexts.length > 0) {
    setImmediate(() => {
      extractNewsEntities(newTexts).catch((err) =>
        console.error("[News Agent] Graph extraction error:", err instanceof Error ? err.message : err)
      );
    });
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

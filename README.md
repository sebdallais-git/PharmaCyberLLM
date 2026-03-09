<div align="center">

# PharmaCyberLLM

### AI-Powered Cyber Threat Intelligence for the Pharmaceutical Industry

**Local LLM** | **Dual RAG** | **Auto Gap-Fill** | **N8N Orchestration** | **Zero Cloud**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-000000?logo=ollama&logoColor=white)](https://ollama.com)
[![ChromaDB](https://img.shields.io/badge/ChromaDB-Vector%20Store-FF6F61?logo=data:image/svg+xml;base64,&logoColor=white)](https://www.trychroma.com)
[![N8N](https://img.shields.io/badge/N8N-Workflow-EA4B71?logo=n8n&logoColor=white)](https://n8n.io)
[![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org)

---

*A fully offline, self-healing RAG chatbot that detects its own knowledge gaps, automatically researches the web, and ingests new intelligence — all orchestrated by N8N. Built for cybersecurity professionals who can't send sensitive queries to the cloud.*

</div>

---

## Why This Exists

> The pharmaceutical industry loses **$50M+ per cyber incident**. SOC analysts need instant access to threat intelligence — attack histories, vendor capabilities, regulatory impacts, pipeline exposure — but can't send proprietary questions to ChatGPT.

PharmaCyberLLM runs **entirely on your machine**. No API keys. No cloud. No data leaves your laptop.

It combines:
- A **local LLM** (via Ollama) for conversational intelligence
- A **dual vector store** (embedded index + ChromaDB) with 36+ curated pharma/cyber documents
- An **automated news agent** that scrubs 90+ topics from Google News every 24 hours
- **Real-time web search** augmentation on every query
- A **self-healing knowledge gap detector** that identifies weak answers and auto-fills them via N8N + SearXNG

The result: an always-current, always-private, self-improving pharma cyber threat expert.

---

## How It Works

```
User asks: "What ransomware attacks hit pharma in 2024?"
                    |
                    v
+-------------------------------------------------------------+
|                   PharmaCyberLLM Pipeline                    |
|                                                             |
|   +----------+   +----------+   +----------+               |
|   | Knowledge |   |   Web    |   |  Ollama  |               |
|   |  Search   |   |  Search  |   |   LLM    |               |
|   | (Hybrid)  |   | (Google) |   | (Local)  |               |
|   +-----+----+   +-----+----+   +-----+----+               |
|         |              |              |                      |
|         +------+-------+------+------+                      |
|                |              |                              |
|         Merged context   Gap Detector                       |
|                |              |                              |
|                v              v                              |
|         Streamed         Low confidence?                     |
|         response       +---> N8N Webhook                    |
|      with sources      |     --> SearXNG search             |
|                        |     --> Ollama extraction           |
|                        +---> Auto-ingest to KB              |
+-------------------------------------------------------------+
                    |
                    v
"In 2024, Change Healthcare suffered a $2.87B breach..."
(citing: cyber-pharma-attacks-extended.md, Google News)

Meanwhile: gap-detector already enriched the KB for next time.
```

---

## Self-Healing Knowledge Loop

The killer feature. PharmaCyberLLM **knows when it doesn't know** — and fixes itself.

```
+------------------+     +-------------------+     +------------------+
|   User Question  | --> |  Ollama Response   | --> |  Gap Detector    |
|                  |     |                    |     |  (Confidence?)   |
+------------------+     +-------------------+     +--------+---------+
                                                            |
                                              Confident?    |    Not confident?
                                              (done)        |    (trigger)
                                                            v
                                                   +--------+---------+
                                                   |   N8N Webhook    |
                                                   +--------+---------+
                                                            |
                              +-----------------------------+----------------------------+
                              |                             |                            |
                              v                             v                            v
                    +---------+--------+      +-------------+---------+    +-------------+---------+
                    | Ollama: Generate |      | SearXNG: Search Web   |    | Ollama: Extract       |
                    | 3 search queries |      | (3 queries x 3 results)|    | relevant knowledge    |
                    +---------+--------+      +-------------+---------+    +-------------+---------+
                              |                             |                            |
                              +-----------------------------+----------------------------+
                                                            |
                                                            v
                                                   +--------+---------+
                                                   |  Store in KB     |
                                                   |  (ingest-text)   |
                                                   +--------+---------+
                                                            |
                                                            v
                                                   +--------+---------+
                                                   |  Next time user  |
                                                   |  asks = better   |
                                                   |  answer!         |
                                                   +------------------+
```

The gap detector uses a 2-hour cooldown per topic to avoid flooding, and logs every detection in SQLite for analytics.

---

## Architecture

```mermaid
graph TB
    subgraph CLIENT["Browser -- Dark UI"]
        CHAT["Chat Interface"]
        KB["Knowledge Base Modal"]
        NA["News Agent Modal"]
    end

    subgraph SERVER["Express Server -- Port 3000"]
        API_CHAT["/api/chat"]
        API_KB["/api/knowledge"]
        API_AGENT["/api/agent"]
    end

    subgraph INTELLIGENCE["Intelligence Layer"]
        RAG["RAG Engine<br/><i>Dual Vector + Keyword Hybrid</i>"]
        WEB["Web Search<br/><i>Google News RSS</i>"]
        AGENT["News Agent<br/><i>90+ topics - 24h cycle</i>"]
        PARSE["File Parser<br/><i>PDF - DOCX - PPTX - CSV - MD</i>"]
        GAP["Gap Detector<br/><i>Confidence check + SQLite log</i>"]
    end

    subgraph ORCHESTRATION["N8N Workflow"]
        N8N_WH["Webhook Trigger"]
        N8N_SEARCH["SearXNG Search"]
        N8N_EXTRACT["Ollama Extraction"]
        N8N_STORE["Auto-Ingest to KB"]
    end

    subgraph LLM["Local LLM -- Ollama"]
        MODEL["gemma2:9b / llama3.2<br/><i>Streaming chat + embeddings</i>"]
    end

    subgraph STORE["Knowledge Store"]
        EMBEDDED["Embedded Index<br/><i>999+ chunks - .index.json</i>"]
        CHROMA["ChromaDB<br/><i>Persistent vector DB</i>"]
        DOCS["36+ Curated Documents<br/><i>Pharma - Cyber - Vendors</i>"]
        NEWS["Ingested News<br/><i>Auto-updated daily</i>"]
        GAPDB["gap_log.db<br/><i>SQLite gap tracking</i>"]
    end

    CHAT -->|SSE Stream| API_CHAT
    KB --> API_KB
    NA --> API_AGENT

    API_CHAT --> RAG
    API_CHAT --> WEB
    API_CHAT --> GAP
    API_KB --> PARSE
    API_AGENT --> AGENT

    GAP -->|Webhook| N8N_WH
    N8N_WH --> N8N_SEARCH
    N8N_SEARCH --> N8N_EXTRACT
    N8N_EXTRACT --> N8N_STORE
    N8N_STORE -->|Ingest| EMBEDDED

    GAP --> GAPDB
    RAG --> EMBEDDED
    RAG --> CHROMA
    AGENT --> WEB
    AGENT -->|Ingest| EMBEDDED
    PARSE -->|Embed & Store| EMBEDDED

    RAG -->|Context| MODEL
    WEB -->|Context| MODEL
    N8N_EXTRACT -->|Process| MODEL
    MODEL -->|Tokens| API_CHAT

    EMBEDDED --- DOCS
    EMBEDDED --- NEWS

    style CLIENT fill:#030712,stroke:#38bdf8,color:#e5e7eb
    style SERVER fill:#111827,stroke:#38bdf8,color:#e5e7eb
    style INTELLIGENCE fill:#1e1b4b,stroke:#a78bfa,color:#e5e7eb
    style ORCHESTRATION fill:#4a1d6b,stroke:#d946ef,color:#e5e7eb
    style LLM fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style STORE fill:#7f1d1d,stroke:#f43f5e,color:#e5e7eb
```

---

## Knowledge Base

PharmaCyberLLM ships with **36+ curated intelligence documents** and **999+ embedded chunks** covering the pharma cyber threat landscape:

```mermaid
mindmap
  root((PharmaCyberLLM<br/>Knowledge))
    Cyber Threats
      Attack history by year
      Attack types & vectors
      Systems compromised
      Threat landscape
      Market value impact
      Costs & remediation
      IT/OT threats 2025
    Pharma Industry
      Business fundamentals
      Drug market forecasts
      Phase 3 pipeline 2025-26
      Science & pharmacology
      Regulation FDA/EMA
      Top 20 by revenue
      Top 20 by market cap
      Top 20 by reputation
      Manufacturing plants
    Vendor Intelligence
      Dell Cyber Recovery
      Snowflake SIEM
      Databricks Security
      ServiceNow SecOps
      Pure Storage SafeMode
      NetApp ONTAP
      HPE Zerto
      VAST Data
      SAP Security
      NVIDIA AI Infra
      WEKA Data Platform
      CrowdStrike / SentinelOne
      Splunk / Microsoft Sentinel
    News (auto-updated)
      90+ monitored topics
      Google News RSS
      24-hour refresh cycle
      Deduplicated ingestion
    Gap-Filled (auto)
      N8N workflow
      SearXNG web search
      Ollama extraction
      Auto-ingested
```

### Curated Documents

| Category | Documents | Coverage |
|----------|-----------|----------|
| **Cyber Attacks** | 8 files | Every major pharma breach 2017-2025, attack vectors, systems compromised, financial impact, costs & remediation |
| **Pharma Business** | 9 files | Drug market forecasts, Phase 3 pipeline, top 20 rankings (revenue, market cap, reputation), manufacturing plants, regulation |
| **Vendor Intel** | 13 files | Dell, Snowflake, Databricks, ServiceNow, Pure Storage, NetApp, HPE, VAST, SAP, NVIDIA, WEKA, CrowdStrike, Splunk |
| **PDF Reports** | 2 files | Everpure AI Pharma Challenge executive briefings |
| **Auto-News** | Daily | 90+ search topics across business, science, cyber, and vendor categories |
| **Gap-Filled** | On-demand | Automatically researched and ingested via N8N when knowledge gaps are detected |

---

## N8N Workflow — Knowledge Gap Auto-Fill

An importable N8N workflow that automatically fills knowledge gaps detected by the chatbot.

```
Webhook POST ──> Ollama (3 queries) ──> SearXNG (web search)
    ──> Fetch pages ──> Ollama (extraction) ──> Filter relevance
    ──> Store in KB ──> Summary log
```

### Workflow Nodes

| # | Node | Type | Description |
|---|------|------|-------------|
| 1 | Knowledge Gap Webhook | Webhook | Receives POST from gap-detector |
| 2 | Generate Search Queries | HTTP Request | Ollama generates 3 search queries |
| 3 | Parse Search Queries | Code | Parses response into 3 items |
| 4 | Search SearXNG | HTTP Request | Web search per query |
| 5 | Deduplicate Results | Code | Deduplicates by URL, max 9 results |
| 6 | Fetch Page Content | HTTP Request | Fetches each page (skip on error) |
| 7 | Truncate & Clean | Code | Strips HTML, limits to 8000 chars |
| 8 | Extract Knowledge | HTTP Request | Ollama extracts relevant facts |
| 9 | Filter Relevant Only | Code | Removes NOT_RELEVANT responses |
| 10 | Store in Knowledge Base | HTTP Request | POSTs to `/api/knowledge/ingest-text` |
| 11 | Summary & Log | Code | Aggregates stats and logs result |

Error handling: Ollama fallback (uses search_topic directly), SearXNG graceful stop, page fetch skip-on-error, configurable timeouts (30s-120s).

Import: **N8N > Workflows > Import from File** > select `n8n/knowledge_gap_workflow.json`

---

## The News Agent

An autonomous agent that keeps the knowledge base current — no manual updates needed.

```
Every 24 hours:
    |
    +-- Scrub 90+ topics across Google News RSS
    |   +-- Pharma business (8 topics)
    |   +-- Pharma science (8 topics)
    |   +-- Cyber threats (8 topics)
    |   +-- Storage & recovery vendors (5 topics)
    |   +-- NVIDIA & AI infra (3 topics)
    |   +-- SIEM & security ops (4 topics)
    |   +-- Security data platforms (2 topics)
    |   +-- IT operations (2 topics)
    |   +-- SAP security (3 topics)
    |   +-- Endpoint & identity (4 topics)
    |   +-- Phase 3 pipeline (6 topics)
    |
    +-- Deduplicate against 2,000 seen titles
    |
    +-- Embed & ingest new articles
    |
    +-- Save updated index
```

---

## Dual RAG Pipeline

The search pipeline uses a **dual-store hybrid approach** — combining an embedded vector index with ChromaDB and keyword matching for maximum recall:

```
Query: "Dell cyber recovery ransomware"
         |
         +-- Embedded Vector Search (70% weight)
         |   +-- Cosine similarity on Ollama embeddings
         |   +-- 999+ pre-indexed chunks
         |
         +-- ChromaDB Vector Search
         |   +-- Persistent vector DB (port 8100)
         |   +-- Gap-filled + URL-ingested content
         |
         +-- Keyword Search (30% weight)
         |   +-- Exact term matching (pharma-specific boost)
         |
         +-- Deduplication
         |   +-- Content-prefix dedup across chunks
         |
         +-- Top 8 chunks --> LLM context window
```

| Parameter | Value |
|-----------|-------|
| Chunk size | 800 characters |
| Embedding model | Ollama (same as chat model) |
| Similarity threshold | 0.2 |
| Top-K retrieval | 8 chunks |
| Hybrid ratio | 70% vector / 30% keyword |
| ChromaDB | Persistent, auto-synced |

---

## File Ingestion

Drop any document into the chat or knowledge base — PharmaCyberLLM parses it instantly:

| Format | Parser | Notes |
|--------|--------|-------|
| `.pdf` | pdf-parse | Full text extraction |
| `.docx` | mammoth | Word document support |
| `.pptx` / `.ppt` | JSZip + XML | Slide-by-slide text extraction |
| `.csv` | Built-in | Header-aware row formatting |
| `.json` | Built-in | Recursive object flattening |
| `.txt` / `.md` | Native | Direct ingestion |

---

## Quick Start

```bash
# 1. Install Ollama (if not already installed)
brew install ollama
ollama pull gemma2:9b

# 2. Clone and install
git clone https://github.com/sebdallais-git/PharmaCyberLLM.git
cd PharmaCyberLLM
npm install

# 3. Start Ollama
ollama serve &

# 4. Launch
npm run dev

# --> http://localhost:3000
```

That's it. No API keys. No `.env` file. No cloud accounts.

### Optional: Enable Self-Healing (N8N + SearXNG)

```bash
# 5. Set the N8N webhook URL
export N8N_WEBHOOK_URL="http://localhost:5678/webhook/knowledge-gap"

# 6. Import the workflow into N8N
#    N8N > Workflows > Import from File > n8n/knowledge_gap_workflow.json

# 7. Ensure SearXNG is running on port 8888
#    and ChromaDB on port 8100

# 8. Restart the server
npm run dev
```

Now when the chatbot gives a weak answer, it automatically researches and learns.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 22 + TypeScript 5.6 | Type-safe server |
| **Server** | Express 4.21 | REST API + static file serving |
| **LLM** | Ollama (gemma2:9b) | Local inference + embeddings |
| **Vector DB** | ChromaDB | Persistent vector store for gap-filled content |
| **Orchestration** | N8N | Workflow automation for knowledge gap filling |
| **Web Search** | SearXNG + Google News RSS | Privacy-first web search |
| **Gap Detection** | Custom + SQLite | Confidence analysis + cooldown + logging |
| **Search** | Hybrid vector + keyword | Dual-store RAG retrieval |
| **Parsing** | pdf-parse, mammoth, JSZip | Multi-format document ingestion |
| **Frontend** | Vanilla HTML/CSS/JS | Dark theme, SSE streaming |
| **Streaming** | Server-Sent Events | Token-by-token chat output |
| **Python** | Utilities | Search and vector DB helpers |

---

## Project Structure

```
PharmaCyberLLM/
+-- src/
|   +-- server.ts                # Express entry point + news agent scheduler
|   +-- api/
|   |   +-- chat.ts              # SSE streaming chat with RAG context injection
|   |   +-- knowledge.ts         # Knowledge base CRUD + search + ChromaDB + gaps API
|   |   +-- agent.ts             # News agent status + manual trigger
|   +-- services/
|       +-- ollama.ts            # Ollama chat, streaming, embeddings, model list
|       +-- knowledge-store.ts   # Vector store -- chunking, embedding, hybrid search
|       +-- chromadb-store.ts    # ChromaDB persistent vector store client
|       +-- gap-detector.ts      # Confidence check, cooldown, SQLite log, N8N webhook
|       +-- news-agent.ts        # 90-topic Google News scraper + dedup + ingest
|       +-- web-search.ts        # Real-time Google News RSS search
|       +-- file-parser.ts       # PDF, DOCX, PPTX, CSV, JSON, MD parser
+-- public/
|   +-- index.html               # Chat UI
|   +-- styles.css               # Dark theme
|   +-- app.js                   # Frontend logic -- chat, modals, file upload
+-- knowledge/                   # 36+ curated pharma/cyber documents
|   +-- cyber-*.md               # 8 cyber threat intelligence files
|   +-- pharma-*.md              # 9 pharma industry files
|   +-- vendor-*.md              # 13 vendor intelligence files
|   +-- *.pdf                    # Executive briefing PDFs
|   +-- .index.json              # Embedded vector index (auto-generated)
+-- n8n/
|   +-- knowledge_gap_workflow.json  # Importable N8N workflow
|   +-- README.md                    # N8N setup guide
+-- python/
|   +-- utils/                   # Search and vector DB helpers
|   +-- tests/                   # Integration + vector DB tests
+-- data/
|   +-- chromadb/                # ChromaDB persistent storage
|   +-- gap_log.db               # SQLite gap detection log
+-- package.json
+-- tsconfig.json
+-- .gitignore
```

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send a message, receive SSE-streamed response with RAG context |
| `/api/chat/models` | GET | List available Ollama models |
| `/api/knowledge/stats` | GET | Knowledge base stats (chunks, sources) |
| `/api/knowledge/search` | POST | Search the knowledge base |
| `/api/knowledge/ingest-text` | POST | Ingest raw text into the knowledge base |
| `/api/knowledge/upload` | POST | Upload and ingest a file (multipart) |
| `/api/knowledge/add` | POST | Add content to ChromaDB (URL or text) |
| `/api/knowledge/status` | GET | ChromaDB connection status and stats |
| `/api/knowledge/gaps` | GET | Recent knowledge gap detections |
| `/api/knowledge/gaps/stats` | GET | Gap detection analytics |
| `/api/agent/status` | GET | News agent last run time + topics |
| `/api/agent/run` | POST | Manually trigger the news agent |

---

## Environment Variables

All optional — PharmaCyberLLM works out of the box with zero configuration.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `CHROMADB_URL` | `http://localhost:8100` | ChromaDB server endpoint |
| `N8N_WEBHOOK_URL` | *(none)* | N8N webhook URL for gap detection auto-fill |

---

## Integration with PharmaCyber

PharmaCyberLLM is designed as a companion to the [PharmaCyber](https://github.com/sebdallais-git/CyberDemo) incident response dashboard. The PharmaCyber dashboard includes a direct link to this chatbot, giving SOC analysts and demo presenters instant access to threat intelligence alongside live scenario execution.

```
+-------------------------------+     +--------------------------+
|    PharmaCyber Dashboard      |     |    PharmaCyberLLM        |
|    (Port 8888)                |---->|    (Port 3000)           |
|                               |     |                          |
| Snowflake - ServiceNow - Dell |     | "What attacks hit        |
| Live incident response demo   |     |  pharma SCADA in 2024?"  |
+-------------------------------+     +----------+---------------+
                                                  |
                                      +-----------v-----------+
                                      |   N8N (Port 5678)     |
                                      |   Auto gap-fill       |
                                      |   SearXNG search      |
                                      +-----------------------+
```

---

<div align="center">

**100% local. Zero cloud. Self-healing. Always current.**

*Ollama LLM* · *Dual RAG* · *ChromaDB* · *N8N Orchestration* · *Gap Detection* · *36+ Curated Intel Documents*

<br/>

Built for pharma cybersecurity professionals who take data sovereignty seriously.

</div>

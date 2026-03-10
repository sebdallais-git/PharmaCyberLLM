# Neo4j Graph RAG for PharmaLLM

## Overview

Add a knowledge graph layer (Neo4j Community Edition) to PharmaLLM, providing both visual exploration via Neo4j Browser and graph-enhanced RAG in the chat pipeline.

## Approach

Hybrid: Python for bulk ingestion/entity extraction, TypeScript for runtime graph queries.

## Infrastructure

- Neo4j Community Edition via Docker (ports 7474 + 7687)
- Persistent volume for data
- Accessible via Tailscale from iPad Safari

## Entity Model

| Entity | Examples |
|--------|---------|
| Company | Pfizer, Merck, Novo Nordisk, AbbVie |
| Subsidiary | Seagen (Pfizer), Alexion (AstraZeneca), Allergan (AbbVie) |
| Drug | Keytruda, Ozempic, Humira, Mounjaro |
| TherapeuticArea | Oncology, GLP-1/Obesity, Immunology, Rare Diseases |
| ManufacturingSite | Kalundborg Denmark, Kalamazoo Michigan, Stein Switzerland |
| Country | USA, Switzerland, Denmark, UK, Japan, Israel |
| RegulatoryBody | FDA, EMA, PMDA, NMPA, Health Canada |
| Regulation | GMP, 21 CFR Part 11, NIS2, DORA, HIPAA, IRA |
| ThreatActor | LockBit, Lazarus Group, APT29, BlackCat |
| Attack | NotPetya 2017, Novartis Breach 2022 |
| AttackVector | Ransomware, Phishing, Supply Chain, Wiper |
| Vendor | Dell, Pure Storage, CrowdStrike, Splunk |
| Product | PowerProtect, SafeMode, Morpheus, ONTAP |
| Technology | mRNA, CRISPR, ADC, CAR-T, Radioligand |

## Relationships

```
# Ownership & structure
Company --acquired--> Subsidiary          {year, price}
Company --headquartered_in--> Country
Company --partners_with--> Company        {drug, type}
Company --revenue--> {amount, year}
Company --market_cap--> {amount, date}

# Manufacturing
Company --operates_site--> ManufacturingSite  {investment, employees}
ManufacturingSite --located_in--> Country
ManufacturingSite --produces--> Drug           {capacity, downtime_cost}

# Drugs & therapy
Company --manufactures--> Drug               {revenue, patent_expiry}
Drug --treats--> TherapeuticArea
Drug --uses_technology--> Technology

# Regulation
RegulatoryBody --oversees--> Country
Regulation --applies_to--> Company
Regulation --applies_to--> ManufacturingSite
Drug --approved_by--> RegulatoryBody        {pathway, date}

# Cyber
Attack --targeted--> Company                {date, cost, impact}
Attack --attributed_to--> ThreatActor
Attack --used_vector--> AttackVector
Attack --hit_site--> ManufacturingSite
ThreatActor --operates_from--> Country

# Defense
Company --uses_vendor--> Vendor
Vendor --provides--> Product
Product --protects_against--> AttackVector
```

## Entity Extraction (Python)

- `python/graph_builder.py` reads all `.md` files from `knowledge/`
- Sends each to Ollama with structured extraction prompt
- Returns JSON: entities + relationships
- Deduplicates by name (fuzzy match)
- Writes to Neo4j via Cypher MERGE (idempotent)
- Processing order: companies/countries first, then drugs/vendors, then attacks

## Live Ingestion (TypeScript)

When `/api/knowledge/ingest-text` or news agent adds a doc:
1. ChromaDB ingestion (existing)
2. Async Ollama entity extraction call (non-blocking)
3. Write extracted entities/relationships to Neo4j
4. Graceful failure — if Neo4j is down, log and continue

## Chat Pipeline Integration

Three parallel searches on each query:
1. ChromaDB vector similarity (existing)
2. Neo4j entity lookup: extract keywords -> fuzzy match nodes -> traverse 1-2 hops
3. Web search (existing, unchanged)

Graph results formatted as bullet points, appended to LLM context alongside ChromaDB chunks.

## New Files

- `python/graph_builder.py` — Bulk extraction script
- `python/requirements.txt` — neo4j, requests
- `src/services/graph-store.ts` — Neo4j driver, query helpers
- `src/api/graph.ts` — API routes

## Modified Files

- `src/api/chat.ts` — Parallel Neo4j query
- `src/api/knowledge.ts` — Trigger entity extraction on ingest
- `src/server.ts` — Register graph routes, health check
- `public/app.js` — Graph context in reasoning panel

## API Routes

- `GET /api/graph/stats` — Node/relationship counts
- `POST /api/graph/search` — Query by entity name
- `POST /api/graph/rebuild` — Re-run full extraction
- `GET /api/graph/health` — Neo4j connection check

## Visual Explorer

Neo4j Browser at `http://mac:7474`, accessible via Tailscale from iPad Safari.

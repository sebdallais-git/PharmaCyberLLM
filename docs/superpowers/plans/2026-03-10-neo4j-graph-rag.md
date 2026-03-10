# Neo4j Graph RAG Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Neo4j knowledge graph layer to PharmaLLM — visual exploration via Neo4j Browser and graph-enhanced RAG in the chat pipeline.

**Architecture:** Hybrid Python/TypeScript. Python script extracts entities from 34 knowledge docs via Ollama and populates Neo4j. TypeScript `neo4j-driver` queries the graph at chat time (parallel to ChromaDB). Live ingestion triggers async entity extraction on every new doc.

**Tech Stack:** Neo4j Community Edition (Docker), neo4j-driver (npm), neo4j (pip), Ollama Mistral Small 24B for entity extraction.

**Spec:** `docs/superpowers/specs/2026-03-10-neo4j-graph-rag-design.md`

---

## File Structure

**New files:**
- `python/graph_builder.py` — Bulk entity extraction + Neo4j population script
- `src/services/graph-store.ts` — TypeScript Neo4j driver: connect, query, write entities, health check
- `src/api/graph.ts` — Express routes: `/api/graph/stats`, `/api/graph/search`, `/api/graph/rebuild`, `/api/graph/health`

**Modified files:**
- `python/requirements.txt` — Add `neo4j` package
- `package.json` — Add `neo4j-driver` dependency
- `src/server.ts` — Import/register graph router, Neo4j startup check
- `src/api/chat.ts` — Parallel Neo4j query alongside ChromaDB, graph context in reasoning panel
- `src/api/knowledge.ts` — Trigger async entity extraction on ingest-text and upload
- `src/api/dashboard.ts` — Add Neo4j to health check endpoint

---

## Chunk 1: Infrastructure + Neo4j Service

### Task 1: Start Neo4j Docker container

**Files:** None (Docker command only)

- [ ] **Step 1: Pull and run Neo4j Community Edition**

```bash
docker run -d \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/pharma2024 \
  -v neo4j_data:/data \
  neo4j:community
```

- [ ] **Step 2: Verify Neo4j is running**

```bash
curl -s http://localhost:7474 | head -5
```

Expected: HTML response from Neo4j Browser.

- [ ] **Step 3: Verify Bolt protocol**

```bash
docker logs neo4j 2>&1 | grep "Bolt enabled"
```

Expected: Line containing "Bolt enabled on 0.0.0.0:7687"

---

### Task 2: Install npm neo4j-driver

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install neo4j-driver**

```bash
cd /Users/seb/claude/PharmaLLM && npm install neo4j-driver
```

- [ ] **Step 2: Verify installation**

```bash
node -e "const neo4j = require('neo4j-driver'); console.log('neo4j-driver loaded:', typeof neo4j.driver)"
```

Expected: `neo4j-driver loaded: function`

---

### Task 3: Create graph-store.ts service

**Files:**
- Create: `src/services/graph-store.ts`

- [ ] **Step 1: Create the Neo4j service module**

```typescript
// Neo4j graph store for entity-relationship queries

import neo4j from "neo4j-driver";
import type { Driver, Session, Record as Neo4jRecord } from "neo4j-driver";

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "pharma2024";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  }
  return driver;
}

export async function isNeo4jAvailable(): Promise<boolean> {
  try {
    const d = getDriver();
    const info = await d.getServerInfo();
    return !!info;
  } catch {
    return false;
  }
}

export async function getNeo4jStats(): Promise<{
  nodeCount: number;
  relationshipCount: number;
  nodesByLabel: Record<string, number>;
  relationshipsByType: Record<string, number>;
}> {
  const session = getDriver().session();
  try {
    const nodeResult = await session.run("MATCH (n) RETURN count(n) AS count");
    const nodeCount = (nodeResult.records[0]?.get("count") as { toNumber(): number }).toNumber();

    const relResult = await session.run("MATCH ()-[r]->() RETURN count(r) AS count");
    const relCount = (relResult.records[0]?.get("count") as { toNumber(): number }).toNumber();

    const labelResult = await session.run(
      "MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC"
    );
    const nodesByLabel: Record<string, number> = {};
    for (const record of labelResult.records) {
      nodesByLabel[record.get("label") as string] = (record.get("count") as { toNumber(): number }).toNumber();
    }

    const typeResult = await session.run(
      "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC"
    );
    const relationshipsByType: Record<string, number> = {};
    for (const record of typeResult.records) {
      relationshipsByType[record.get("type") as string] = (record.get("count") as { toNumber(): number }).toNumber();
    }

    return { nodeCount, relationshipCount: relCount, nodesByLabel, relationshipsByType };
  } finally {
    await session.close();
  }
}

export interface GraphEntity {
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface GraphRelationship {
  from: string;
  to: string;
  fromType: string;
  toType: string;
  type: string;
  properties: Record<string, unknown>;
}

const VALID_LABELS = new Set([
  "Company", "Subsidiary", "Drug", "TherapeuticArea",
  "ManufacturingSite", "Country", "RegulatoryBody", "Regulation",
  "ThreatActor", "Attack", "AttackVector", "Vendor", "Product", "Technology",
]);

function sanitizeLabel(raw: string): string | null {
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!cleaned || !VALID_LABELS.has(cleaned)) return null;
  return cleaned;
}

export async function writeEntities(
  entities: GraphEntity[],
  relationships: GraphRelationship[]
): Promise<{ nodesProcessed: number; relsProcessed: number }> {
  const session = getDriver().session();
  let nodesProcessed = 0;
  let relsProcessed = 0;

  try {
    // Upsert entities
    for (const entity of entities) {
      const label = sanitizeLabel(entity.type);
      if (!label) continue;
      await session.run(
        `MERGE (n:${label} {name: $name}) SET n += $props`,
        { name: entity.name, props: entity.properties }
      );
      nodesProcessed++;
    }

    // Upsert relationships
    for (const rel of relationships) {
      const fromLabel = sanitizeLabel(rel.fromType);
      const toLabel = sanitizeLabel(rel.toType);
      if (!fromLabel || !toLabel) continue;
      const relType = rel.type.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
      if (!relType) continue;
      await session.run(
        `MATCH (a:${fromLabel} {name: $from}), (b:${toLabel} {name: $to})
         MERGE (a)-[r:${relType}]->(b) SET r += $props`,
        { from: rel.from, to: rel.to, props: rel.properties }
      );
      relsProcessed++;
    }

    return { nodesProcessed, relsProcessed };
  } finally {
    await session.close();
  }
}

export interface GraphSearchResult {
  entity: string;
  type: string;
  properties: Record<string, unknown>;
  relationships: Array<{
    relType: string;
    direction: string;
    targetName: string;
    targetType: string;
    relProperties: Record<string, unknown>;
  }>;
}

export async function searchGraph(entityName: string): Promise<GraphSearchResult[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (n)
       WHERE toLower(n.name) CONTAINS toLower($name)
       OPTIONAL MATCH (n)-[r]-(m)
       RETURN n, labels(n) AS labels, collect({
         relType: type(r),
         direction: CASE WHEN startNode(r) = n THEN 'outgoing' ELSE 'incoming' END,
         targetName: m.name,
         targetLabels: labels(m),
         relProps: properties(r)
       }) AS rels
       LIMIT 10`,
      { name: entityName }
    );

    const results: GraphSearchResult[] = [];
    for (const record of result.records) {
      const node = record.get("n");
      const labels = record.get("labels") as string[];
      const rels = record.get("rels") as Array<{
        relType: string | null;
        direction: string;
        targetName: string | null;
        targetLabels: string[];
        relProps: Record<string, unknown>;
      }>;

      results.push({
        entity: node.properties.name as string,
        type: labels[0] ?? "Unknown",
        properties: node.properties as Record<string, unknown>,
        relationships: rels
          .filter((r) => r.relType !== null)
          .map((r) => ({
            relType: r.relType as string,
            direction: r.direction,
            targetName: r.targetName ?? "unknown",
            targetType: (r.targetLabels ?? [])[0] ?? "Unknown",
            relProperties: r.relProps,
          })),
      });
    }

    return results;
  } finally {
    await session.close();
  }
}

export async function queryGraphForChat(keywords: string[]): Promise<string> {
  if (keywords.length === 0) return "";

  const session = getDriver().session();
  try {
    // Search for nodes matching any keyword, traverse 1-2 hops
    const whereClauses = keywords.map((_, i) => `toLower(n.name) CONTAINS toLower($kw${i})`).join(" OR ");
    const params: Record<string, string> = {};
    keywords.forEach((kw, i) => { params[`kw${i}`] = kw; });

    const result = await session.run(
      `MATCH (n)
       WHERE ${whereClauses}
       OPTIONAL MATCH (n)-[r1]-(hop1)
       OPTIONAL MATCH (hop1)-[r2]-(hop2)
       WHERE hop2 <> n
       WITH n, labels(n) AS nLabels,
            collect(DISTINCT {rel: type(r1), target: hop1.name, targetType: labels(hop1)[0]}) AS direct,
            collect(DISTINCT {rel1: type(r1), mid: hop1.name, rel2: type(r2), target: hop2.name, targetType: labels(hop2)[0]}) AS twoHop
       RETURN n.name AS name, nLabels, properties(n) AS props, direct, twoHop
       LIMIT 5`,
      params
    );

    if (result.records.length === 0) return "";

    const lines: string[] = ["[Graph Context]"];
    for (const record of result.records) {
      const name = record.get("name") as string;
      const labels = record.get("nLabels") as string[];
      const props = record.get("props") as Record<string, unknown>;
      const direct = record.get("direct") as Array<{ rel: string | null; target: string | null; targetType: string | null }>;

      lines.push(`- ${name} (${labels[0] ?? "Entity"})`);

      // Add key properties
      for (const [key, val] of Object.entries(props)) {
        if (key !== "name" && val !== null && val !== undefined && String(val).length < 200) {
          lines.push(`  ${key}: ${String(val)}`);
        }
      }

      // Add direct relationships (deduplicated)
      const seen = new Set<string>();
      for (const d of direct) {
        if (d.rel && d.target) {
          const key = `${d.rel}-${d.target}`;
          if (!seen.has(key)) {
            seen.add(key);
            lines.push(`  --${d.rel.toLowerCase().replace(/_/g, " ")}--> ${d.target} (${d.targetType ?? "?"})`);
          }
        }
      }
    }

    return lines.join("\n");
  } finally {
    await session.close();
  }
}

export async function clearGraph(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run("MATCH (n) DETACH DELETE n");
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/seb/claude/PharmaLLM && npx tsc --noEmit
```

Expected: No errors (or only pre-existing errors unrelated to graph-store).

- [ ] **Step 3: Commit**

```bash
git add src/services/graph-store.ts package.json package-lock.json
git commit -m "feat: add Neo4j graph store service with entity CRUD and chat query support"
```

---

### Task 4: Create graph API routes

**Files:**
- Create: `src/api/graph.ts`
- Modify: `src/server.ts:7-9` (add import)
- Modify: `src/server.ts:36-41` (add route registration)

- [ ] **Step 1: Create graph.ts router**

```typescript
// API routes for knowledge graph

import { Router } from "express";
import type { Request, Response } from "express";
import {
  isNeo4jAvailable,
  getNeo4jStats,
  searchGraph,
  clearGraph,
} from "../services/graph-store.js";

const router = Router();

// GET /api/graph/health
router.get("/health", async (_req: Request, res: Response): Promise<void> => {
  const start = Date.now();
  const available = await isNeo4jAvailable();
  const latency = Date.now() - start;

  res.json({
    neo4j: available,
    latency_ms: latency,
  });
});

// GET /api/graph/stats
router.get("/stats", async (_req: Request, res: Response): Promise<void> => {
  try {
    const available = await isNeo4jAvailable();
    if (!available) {
      res.status(503).json({ error: "Neo4j is not reachable" });
      return;
    }

    const stats = await getNeo4jStats();
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/graph/search - Search graph by entity name
router.post("/search", async (req: Request, res: Response): Promise<void> => {
  const { name } = req.body as { name: string };

  if (!name) {
    res.status(400).json({ error: "The 'name' field is required" });
    return;
  }

  try {
    const results = await searchGraph(name);
    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/graph/rebuild - Trigger full graph rebuild (calls Python script)
router.post("/rebuild", async (_req: Request, res: Response): Promise<void> => {
  const { execFile } = await import("node:child_process");

  try {
    const available = await isNeo4jAvailable();
    if (!available) {
      res.status(503).json({ error: "Neo4j is not reachable" });
      return;
    }

    // Clear existing graph first
    await clearGraph();

    // Run Python graph builder
    execFile(
      "python3",
      ["python/graph_builder.py"],
      { cwd: process.cwd(), timeout: 600000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error("[Graph Rebuild] Error:", stderr);
          // Response may already be sent if timeout
          if (!res.writableEnded) {
            res.status(500).json({ error: stderr || err.message });
          }
          return;
        }
        console.log("[Graph Rebuild]", stdout);
        if (!res.writableEnded) {
          res.json({ message: "Graph rebuild complete", output: stdout });
        }
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

export default router;
```

- [ ] **Step 2: Register route in server.ts**

Add two imports after line 17 (the last existing import) of `src/server.ts`:
```typescript
import graphRouter from "./api/graph.js";
import { isNeo4jAvailable, getNeo4jStats } from "./services/graph-store.js";
```

Add route registration after line 40 (`app.use("/api/dashboard", dashboardRouter)`):
```typescript
app.use("/api/graph", graphRouter);
```

- [ ] **Step 3: Add Neo4j to startup check in server.ts**

After the ChromaDB check block (after line 76, the closing of the ChromaDB `else`), add:
```typescript
  // Check Neo4j availability
  const neo4jOk = await isNeo4jAvailable();
  if (neo4jOk) {
    const stats = await getNeo4jStats();
    console.log(`Neo4j: connected (${stats.nodeCount} nodes, ${stats.relationshipCount} relationships)`);
  } else {
    console.log("Neo4j: not available — graph RAG will be skipped");
  }
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/seb/claude/PharmaLLM && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/graph.ts src/server.ts
git commit -m "feat: add graph API routes and Neo4j startup check"
```

---

## Chunk 2: Python Entity Extraction + Graph Population

### Task 5: Add neo4j to Python requirements

**Files:**
- Modify: `python/requirements.txt`

- [ ] **Step 1: Add neo4j package**

Append to `python/requirements.txt`:
```
neo4j>=5.0.0
```

- [ ] **Step 2: Install**

```bash
cd /Users/seb/claude/PharmaLLM && pip install -r python/requirements.txt
```

---

### Task 6: Create Python graph builder script

**Files:**
- Create: `python/graph_builder.py`

- [ ] **Step 1: Create the graph builder script**

```python
"""Extract entities and relationships from PharmaLLM knowledge base and populate Neo4j.

Usage:
    python python/graph_builder.py                  # Process all .md files
    python python/graph_builder.py knowledge/pharma-business.md  # Single file

Requires: Neo4j running on bolt://localhost:7687, Ollama running on localhost:11434
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from neo4j import GraphDatabase

# Configuration
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "pharma2024")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "mistral-small:24b")
KNOWLEDGE_DIR = Path(__file__).resolve().parents[1] / "knowledge"

ENTITY_TYPES = [
    "Company", "Subsidiary", "Drug", "TherapeuticArea",
    "ManufacturingSite", "Country", "RegulatoryBody", "Regulation",
    "ThreatActor", "Attack", "AttackVector", "Vendor", "Product", "Technology",
]

RELATIONSHIP_TYPES = [
    "ACQUIRED", "HEADQUARTERED_IN", "PARTNERS_WITH",
    "OPERATES_SITE", "LOCATED_IN", "PRODUCES",
    "MANUFACTURES", "TREATS", "USES_TECHNOLOGY",
    "OVERSEES", "APPLIES_TO", "APPROVED_BY",
    "TARGETED", "ATTRIBUTED_TO", "USED_VECTOR", "HIT_SITE", "OPERATES_FROM",
    "USES_VENDOR", "PROVIDES", "PROTECTS_AGAINST",
]

EXTRACTION_PROMPT = """You are an entity extraction engine for a pharmaceutical cybersecurity knowledge base.

Given the following document, extract ALL entities and relationships.

ENTITY TYPES: {entity_types}

RELATIONSHIP TYPES: {relationship_types}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{{
  "entities": [
    {{"type": "Company", "name": "Pfizer", "properties": {{"headquarters": "New York", "revenue_2024": "$59B"}}}}
  ],
  "relationships": [
    {{"from": "Pfizer", "fromType": "Company", "to": "Seagen", "toType": "Subsidiary", "type": "ACQUIRED", "properties": {{"year": 2023, "price": "$43B"}}}}
  ]
}}

Rules:
- Use the EXACT entity type names from the list above.
- Use the EXACT relationship type names from the list above.
- Entity names should be canonical: "Merck & Co" not "Merck & Co (MSD)".
- For each entity, include all relevant properties found in the text.
- Include ALL entities and relationships you can find, not just the main ones.
- Properties should have string or number values only.
- Return empty arrays if no entities/relationships found.

DOCUMENT:
{document}"""


def call_ollama(prompt: str) -> str:
    """Call Ollama generate endpoint."""
    resp = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.1, "num_ctx": 8192},
        },
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json().get("response", "")


def parse_extraction(response: str) -> dict:
    """Parse JSON from Ollama response, handling common issues."""
    # Try to find JSON object in response
    json_match = re.search(r"\{[\s\S]*\}", response)
    if not json_match:
        return {"entities": [], "relationships": []}

    try:
        data = json.loads(json_match.group())
        # Validate structure
        if "entities" not in data:
            data["entities"] = []
        if "relationships" not in data:
            data["relationships"] = []
        return data
    except json.JSONDecodeError:
        print(f"  WARNING: Failed to parse JSON from response")
        return {"entities": [], "relationships": []}


def clean_entity_name(name: str) -> str:
    """Normalize entity names for deduplication."""
    # Remove parenthetical suffixes
    name = re.sub(r"\s*\(.*?\)\s*$", "", name).strip()
    # Remove trailing punctuation
    name = name.rstrip(".,;:")
    return name


def write_to_neo4j(driver, entities: list[dict], relationships: list[dict]) -> tuple[int, int]:
    """Write extracted entities and relationships to Neo4j."""
    nodes_written = 0
    rels_written = 0

    with driver.session() as session:
        # Create uniqueness constraints (idempotent)
        for entity_type in ENTITY_TYPES:
            try:
                session.run(
                    f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{entity_type}) REQUIRE n.name IS UNIQUE"
                )
            except Exception:
                pass  # Constraint may already exist

        # Upsert entities
        for entity in entities:
            label = entity.get("type", "Entity").replace(" ", "")
            name = clean_entity_name(entity.get("name", ""))
            if not name or label not in ENTITY_TYPES:
                continue

            props = entity.get("properties", {})
            # Filter to string/number values only
            clean_props = {k: v for k, v in props.items() if isinstance(v, (str, int, float)) and k != "name"}

            session.run(
                f"MERGE (n:{label} {{name: $name}}) SET n += $props",
                name=name, props=clean_props,
            )
            nodes_written += 1

        # Upsert relationships
        for rel in relationships:
            from_name = clean_entity_name(rel.get("from", ""))
            to_name = clean_entity_name(rel.get("to", ""))
            from_type = rel.get("fromType", "Entity").replace(" ", "")
            to_type = rel.get("toType", "Entity").replace(" ", "")
            rel_type = rel.get("type", "RELATED_TO").replace(" ", "_").upper()

            if not from_name or not to_name:
                continue
            if from_type not in ENTITY_TYPES or to_type not in ENTITY_TYPES:
                continue

            props = rel.get("properties", {})
            clean_props = {k: v for k, v in props.items() if isinstance(v, (str, int, float))}

            try:
                session.run(
                    f"""MATCH (a:{from_type} {{name: $from_name}}), (b:{to_type} {{name: $to_name}})
                        MERGE (a)-[r:{rel_type}]->(b) SET r += $props""",
                    from_name=from_name, to_name=to_name, props=clean_props,
                )
                rels_written += 1
            except Exception as exc:
                print(f"  WARNING: Failed to create relationship {from_name}-[{rel_type}]->{to_name}: {exc}")

    return nodes_written, rels_written


def process_file(driver, filepath: Path) -> tuple[int, int]:
    """Process a single knowledge file: extract entities and write to Neo4j."""
    text = filepath.read_text(encoding="utf-8")

    # Skip very short files
    if len(text) < 100:
        print(f"  Skipping {filepath.name}: too short")
        return 0, 0

    # Truncate very long files to fit context window
    if len(text) > 24000:
        text = text[:24000] + "\n\n[TRUNCATED]"

    prompt = EXTRACTION_PROMPT.format(
        entity_types=", ".join(ENTITY_TYPES),
        relationship_types=", ".join(RELATIONSHIP_TYPES),
        document=text,
    )

    print(f"  Extracting entities from {filepath.name}...")
    start = time.time()
    response = call_ollama(prompt)
    elapsed = time.time() - start
    print(f"  Ollama responded in {elapsed:.1f}s")

    data = parse_extraction(response)
    entities = data.get("entities", [])
    relationships = data.get("relationships", [])
    print(f"  Found {len(entities)} entities, {len(relationships)} relationships")

    if entities or relationships:
        nodes, rels = write_to_neo4j(driver, entities, relationships)
        return nodes, rels

    return 0, 0


def main():
    """Process all knowledge base files or a specific file."""
    # Determine files to process
    if len(sys.argv) > 1:
        files = [Path(f) for f in sys.argv[1:] if Path(f).exists()]
    else:
        files = sorted(KNOWLEDGE_DIR.glob("*.md"))

    if not files:
        print("No files to process.")
        return

    print(f"Connecting to Neo4j at {NEO4J_URI}...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    driver.verify_connectivity()
    print("Connected to Neo4j.\n")

    # Process files in order: companies/countries first, then cyber, then vendors
    priority_order = [
        "pharma-basics", "pharma-business", "pharma-top20-revenue",
        "pharma-top20-market-cap", "pharma-top20-reputation",
        "pharma-regulation", "pharma-science",
        "pharma-manufacturing-plants", "pharma-drug-market-value-forecasts",
        "pharma-phase3-pipeline", "pharma-news",
    ]

    def sort_key(f: Path) -> int:
        stem = f.stem
        for i, prefix in enumerate(priority_order):
            if stem.startswith(prefix):
                return i
        if stem.startswith("cyber"):
            return 100
        if stem.startswith("vendor"):
            return 200
        return 300

    files.sort(key=sort_key)

    total_nodes = 0
    total_rels = 0
    total_start = time.time()

    for filepath in files:
        print(f"\n[{files.index(filepath) + 1}/{len(files)}] {filepath.name}")
        try:
            nodes, rels = process_file(driver, filepath)
            total_nodes += nodes
            total_rels += rels
        except Exception as exc:
            print(f"  ERROR: {exc}")

    total_elapsed = time.time() - total_start
    print(f"\n{'='*60}")
    print(f"Graph build complete in {total_elapsed:.0f}s")
    print(f"Total nodes: {total_nodes}")
    print(f"Total relationships: {total_rels}")
    print(f"Files processed: {len(files)}")

    driver.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test with a single file**

```bash
cd /Users/seb/claude/PharmaLLM && python3 python/graph_builder.py knowledge/pharma-business.md
```

Expected: Output showing entities and relationships extracted, written to Neo4j.

- [ ] **Step 3: Verify in Neo4j Browser**

Open `http://localhost:7474` in Safari. Run:
```cypher
MATCH (n) RETURN n LIMIT 25
```

Expected: Visual graph showing nodes from the pharma-business doc.

- [ ] **Step 4: Commit**

```bash
git add python/graph_builder.py python/requirements.txt
git commit -m "feat: add Python graph builder for Neo4j entity extraction via Ollama"
```

---

### Task 7: Run full graph build from all knowledge docs

**Files:** None (execution only)

- [ ] **Step 1: Run full extraction**

```bash
cd /Users/seb/claude/PharmaLLM && python3 python/graph_builder.py
```

Expected: All 34 files processed. This will take time (~2-5 min per file with Mistral Small 24B).

- [ ] **Step 2: Verify graph stats**

In Neo4j Browser:
```cypher
MATCH (n) RETURN labels(n)[0] AS type, count(*) AS count ORDER BY count DESC
```

Expected: Counts for each entity type.

```cypher
MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC
```

Expected: Counts for each relationship type.

- [ ] **Step 3: Test a visual query — the wow moment**

In Neo4j Browser:
```cypher
MATCH (c:Company)-[r]-(n) WHERE c.name = "Pfizer" RETURN c, r, n
```

Expected: Visual graph showing Pfizer's connections to subsidiaries, drugs, attacks, vendors, etc.

---

## Chunk 3: Chat Pipeline Integration

### Task 8: Add graph context to chat pipeline

**Files:**
- Modify: `src/api/chat.ts:10-18` (add imports)
- Modify: `src/api/chat.ts:133-196` (add parallel Neo4j query)

- [ ] **Step 1: Add imports to chat.ts**

At the top of `src/api/chat.ts`, modify the existing Ollama import at line 10 to add `chatWithOllama`:
```typescript
import { streamChatWithOllama, listModels, chatWithOllama } from "../services/ollama.js";
```

Then add after line 18 (the last import):
```typescript
import { isNeo4jAvailable, queryGraphForChat } from "../services/graph-store.js";
```

- [ ] **Step 2: Add entity keyword extraction function**

After the `extractSearchQuery` function (after line 57), add:
```typescript
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
```

- [ ] **Step 3: Add parallel Neo4j query in the chat handler**

After the ChromaDB miss logging block (after line 195 — `}`), and before the web search block, add:

```typescript
  // Graph knowledge search (parallel with web search)
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
```

Then wrap the existing web search in a promise too, and await both:

Replace the web search block (lines 198-216) with:
```typescript
  // Web search (parallel with graph search)
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

  // Wait for both graph and web searches
  await Promise.all([graphSearchPromise, webSearchPromise]);

  // Append graph context if available
  if (graphContext) {
    contextBlock += "\n\n" + graphContext;
  }
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/seb/claude/PharmaLLM && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/chat.ts
git commit -m "feat: add parallel Neo4j graph query in chat pipeline"
```

---

## Chunk 4: Live Ingestion + Dashboard Integration

### Task 9: Add async entity extraction on ingestion

**Files:**
- Modify: `src/api/knowledge.ts:32-33` (add import)
- Modify: `src/api/knowledge.ts:82-93` (add graph extraction to ingest-text)
- Modify: `src/api/knowledge.ts:96-128` (add graph extraction to upload)

- [ ] **Step 1: Add imports to knowledge.ts**

After line 33 of `src/api/knowledge.ts`, add:
```typescript
import { isNeo4jAvailable, writeEntities } from "../services/graph-store.js";
import type { GraphEntity, GraphRelationship } from "../services/graph-store.js";
```

- [ ] **Step 2: Add entity extraction helper**

After the `saveRawDocument` function (after line 58), add:
```typescript
async function extractAndWriteEntities(text: string, source: string): Promise<void> {
  try {
    const neo4jOk = await isNeo4jAvailable();
    if (!neo4jOk) return;

    const extractionPrompt = `You are an entity extraction engine. Extract entities and relationships from this text.
Entity types: Company, Subsidiary, Drug, TherapeuticArea, ManufacturingSite, Country, RegulatoryBody, Regulation, ThreatActor, Attack, AttackVector, Vendor, Product, Technology
Return ONLY valid JSON: {"entities": [{"type": "...", "name": "...", "properties": {...}}], "relationships": [{"from": "...", "fromType": "...", "to": "...", "toType": "...", "type": "...", "properties": {...}}]}`;

    const response = await chatWithOllama(
      [
        { role: "system", content: extractionPrompt },
        { role: "user", content: text.slice(0, 12000) },
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
      console.log(`[Graph] Extracted ${result.nodesProcessed} nodes, ${result.relsProcessed} rels from ${source}`);
    }
  } catch (err) {
    console.error(`[Graph] Entity extraction failed for ${source}:`, err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 3: Trigger extraction in ingest-text handler**

In the `POST /ingest-text` handler, after `await saveIndex();` (line 91), add:
```typescript
  // Async graph entity extraction (non-blocking)
  setImmediate(() => {
    extractAndWriteEntities(text, source).catch((err) =>
      console.error("[Graph] Async extraction error:", err)
    );
  });
```

- [ ] **Step 4: Trigger extraction in upload handler**

In the `POST /upload` handler, after `await saveIndex();` (line 121), add:
```typescript
    // Async graph entity extraction (non-blocking)
    setImmediate(() => {
      extractAndWriteEntities(text, file.originalname).catch((err) =>
        console.error("[Graph] Async extraction error:", err)
      );
    });
```

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/seb/claude/PharmaLLM && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/knowledge.ts
git commit -m "feat: add live Neo4j entity extraction on knowledge ingestion"
```

---

### Task 10: Add Neo4j to health check

**Files:**
- Modify: `src/api/dashboard.ts:6-7` (add import)
- Modify: health check endpoint

- [ ] **Step 1: Add import**

At the top of `src/api/dashboard.ts`, add:
```typescript
import { isNeo4jAvailable } from "../services/graph-store.js";
```

- [ ] **Step 2: Find the health check endpoint and add Neo4j**

Locate the `/api/health` GET handler in `src/api/dashboard.ts`. Add a Neo4j check alongside the existing Ollama, ChromaDB, and SearXNG checks:

```typescript
    // Neo4j
    const neo4jStart = Date.now();
    let neo4jOk = false;
    try {
      neo4jOk = await isNeo4jAvailable();
    } catch { /* not available */ }
    const neo4jLatency = Date.now() - neo4jStart;
```

Add to the response object:
```typescript
    neo4j: { ok: neo4jOk, latency_ms: neo4jLatency },
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/seb/claude/PharmaLLM && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/api/dashboard.ts
git commit -m "feat: add Neo4j health check to dashboard API"
```

---

### Task 11: Add graph reasoning to frontend

**Files:**
- Modify: `public/app.js` (reasoning panel update)

- [ ] **Step 1: Find the reasoning panel handler in app.js**

The SSE handler that displays reasoning steps. The graph reasoning messages (`"Searching knowledge graph..."`, `"Found N entities..."`) will automatically appear because the backend sends them as `{reasoning: ...}` SSE events. No frontend changes needed for basic display.

However, if you want a distinct icon/style for graph results, add to the reasoning display function a check for messages containing "knowledge graph" or "entities" and style them differently (optional, can be done later).

- [ ] **Step 2: Commit (if changes were made)**

```bash
git add public/app.js
git commit -m "feat: display graph context in reasoning panel"
```

---

## Chunk 5: Final Verification

### Task 12: End-to-end test

- [ ] **Step 1: Start the server**

```bash
cd /Users/seb/claude/PharmaLLM && npm run dev
```

- [ ] **Step 2: Test graph health**

```bash
curl -s http://localhost:3000/api/graph/health | python3 -m json.tool
```

Expected: `{"neo4j": true, "latency_ms": ...}`

- [ ] **Step 3: Test graph stats**

```bash
curl -s http://localhost:3000/api/graph/stats | python3 -m json.tool
```

Expected: Node and relationship counts by type.

- [ ] **Step 4: Test graph search**

```bash
curl -s -X POST http://localhost:3000/api/graph/search \
  -H "Content-Type: application/json" \
  -d '{"name": "Pfizer"}' | python3 -m json.tool
```

Expected: Pfizer entity with its relationships.

- [ ] **Step 5: Test chat with graph context**

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Which companies were attacked by LockBit?", "webSearch": false}' \
  --no-buffer
```

Expected: SSE stream includes `"Searching knowledge graph..."` reasoning step.

- [ ] **Step 6: Test Neo4j Browser from iPad**

Open `http://your-tailscale-ip:7474` in iPad Safari. Run:
```cypher
MATCH (c:Company)-[r]-(n) RETURN c, r, n LIMIT 50
```

Expected: Interactive visual graph.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete Neo4j Graph RAG integration with visual explorer"
```

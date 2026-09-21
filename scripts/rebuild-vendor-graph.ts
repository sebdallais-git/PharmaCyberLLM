// Rebuild the vendor-intelligence graph from knowledge/vendors/*.md.
//
// Usage:
//   npx tsx scripts/rebuild-vendor-graph.ts          dry run, prints the plan
//   npx tsx scripts/rebuild-vendor-graph.ts --apply  merge into the graph
//   npx tsx scripts/rebuild-vendor-graph.ts --apply --rebuild
//                                                    WIPE the graph, then write
//
// --rebuild is destructive. Export first: scripts/export-graph.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import neo4j from "neo4j-driver";
import { briefToGraphFacts, parseVendorBrief } from "../src/services/graph-schema.js";
import { writeGraphFacts, type GraphWriter } from "../src/services/graph-writer.js";

const URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const USER = process.env.NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD ?? "pharma2024";
const BRIEFS = join(process.cwd(), "knowledge", "vendors");

const apply = process.argv.includes("--apply");
const rebuild = process.argv.includes("--rebuild");

const batch = readdirSync(BRIEFS)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const brief = parseVendorBrief(readFileSync(join(BRIEFS, f), "utf8"));
    return { file: f, brief, facts: briefToGraphFacts(brief) };
  });

for (const { file, brief, facts } of batch) {
  console.log(
    `${file.padEnd(28)} ${brief.vendor}/${brief.segment} ${brief.position}/${brief.confidence}` +
      ` -> ${facts.nodes.length} nodes, ${facts.relationships.length} rels`,
  );
}

if (!apply) {
  // Still runs the whole validation and dedupe path, just against a writer that
  // records instead of writing -- a dry run that skipped it would prove nothing.
  const counted = { nodes: 0, relationships: 0 };
  const noop: GraphWriter = {
    async clear() {},
    async mergeNode() {
      counted.nodes++;
    },
    async mergeRelationship() {
      counted.relationships++;
    },
  };
  await writeGraphFacts(batch.map((b) => b.facts), noop);
  console.log(`\nDRY RUN — would write ${counted.nodes} nodes and ${counted.relationships} relationships`);
  console.log("pass --apply to write, add --rebuild to wipe the graph first");
  process.exit(0);
}

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
const session = driver.session();

const liveWriter: GraphWriter = {
  async clear() {
    await session.run("MATCH (n) DETACH DELETE n");
  },
  async mergeNode(label, id, properties) {
    // The label is interpolated because Cypher cannot parameterise it; it is
    // safe only because writeGraphFacts has already checked it against the
    // closed set. Never relax that check.
    await session.run(`MERGE (n:${label} {id: $id}) SET n += $properties`, { id, properties });
  },
  async mergeRelationship(type, from, to, properties) {
    await session.run(
      `MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${type}]->(b) SET r += $properties`,
      { from, to, properties },
    );
  },
};

try {
  if (rebuild) console.log("\nWIPING the graph before writing (--rebuild)");
  const written = await writeGraphFacts(batch.map((b) => b.facts), liveWriter, { rebuild });
  console.log(`\nAPPLIED — ${written.nodes} nodes, ${written.relationships} relationships`);

  const check = await session.run(
    "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS rels, count(DISTINCT type(r)) AS types",
  );
  const row = check.records[0];
  console.log(
    `graph now holds ${row.get("nodes")} nodes, ${row.get("rels")} relationships, ` +
      `${row.get("types")} distinct relationship types`,
  );
} finally {
  await session.close();
  await driver.close();
}

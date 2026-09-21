// Writes vendor-intelligence facts into a graph, with the closed vocabularies
// enforced a second time at the boundary.
//
// Parsing already validates, so this is defence in depth: the writer is the last
// place a bad label or edge type can be stopped, and the graph it replaces grew
// 174 relationship types precisely because nothing checked at the boundary.
import {
  NODE_LABELS,
  RELATIONSHIP_TYPES,
  type GraphFacts,
  type GraphNode,
  type GraphRelationship,
  type NodeLabel,
  type RelationshipType,
} from "./graph-schema.js";

export interface GraphWriter {
  /** Remove every node and relationship. Only called for a full rebuild. */
  clear(): Promise<void>;
  /** Idempotent: writing the same node twice must leave one node. */
  mergeNode(label: NodeLabel, id: string, properties: Record<string, unknown>): Promise<void>;
  /** Idempotent, and both endpoints are guaranteed to exist by the time this is called. */
  mergeRelationship(
    type: RelationshipType,
    from: string,
    to: string,
    properties: Record<string, unknown>,
  ): Promise<void>;
}

function assertLabel(node: GraphNode): void {
  if (!(NODE_LABELS as readonly string[]).includes(node.label)) {
    throw new Error(`refusing to write node with label "${node.label}" (not in the closed set)`);
  }
}

function assertType(rel: GraphRelationship): void {
  if (!(RELATIONSHIP_TYPES as readonly string[]).includes(rel.type)) {
    throw new Error(`refusing to write relationship of type "${rel.type}" (not in the closed set)`);
  }
}

/**
 * Write the facts from every brief as one graph.
 *
 * Nodes are deduplicated across briefs: `dell` is asserted by each of its own
 * briefs and must end up as a single node. Relationship endpoints must resolve
 * to a node in the same batch -- a dangling edge is how a graph quietly acquires
 * vendors nobody has researched, which is exactly what the competitor lists
 * would do if they were trusted.
 */
export async function writeGraphFacts(
  batch: GraphFacts[],
  writer: GraphWriter,
  options: { rebuild?: boolean } = {},
): Promise<{ nodes: number; relationships: number }> {
  const nodes = new Map<string, GraphNode>();
  for (const facts of batch) {
    for (const node of facts.nodes) {
      assertLabel(node);
      const key = `${node.label}:${node.id}`;
      // Later briefs may carry fresher properties for the same node; merge them
      // rather than letting file order decide.
      const existing = nodes.get(key);
      nodes.set(key, existing ? { ...node, properties: { ...existing.properties, ...node.properties } } : node);
    }
  }

  const known = new Set([...nodes.values()].map((n) => n.id));
  const relationships: GraphRelationship[] = [];
  for (const facts of batch) {
    for (const rel of facts.relationships) {
      assertType(rel);
      for (const endpoint of [rel.from, rel.to]) {
        if (!known.has(endpoint)) {
          throw new Error(
            `refusing to write ${rel.type} to "${endpoint}": no node declares it. ` +
              "A vendor enters a segment through its own brief, not by being named as a competitor.",
          );
        }
      }
      relationships.push(rel);
    }
  }

  if (options.rebuild) await writer.clear();

  for (const node of nodes.values()) await writer.mergeNode(node.label, node.id, node.properties);
  for (const rel of relationships) await writer.mergeRelationship(rel.type, rel.from, rel.to, rel.properties);

  return { nodes: nodes.size, relationships: relationships.length };
}

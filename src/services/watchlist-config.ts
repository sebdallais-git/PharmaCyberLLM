// Watchlist config schema and loader.
//
// config/watchlist.yaml is the single definition of who is watched (customers,
// their peer sets, IT vendors) and what topics are tracked with no named entity.
// This module parses that document into typed structures consumed by every
// later watchlist task (adapters, item store, tagger, ingest).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlDocument } from "yaml";

export const DOMAINS = [
  "cyber",
  "ai",
  "cloud",
  "infrastructure",
  "rnd_it",
  "mfg_it",
  "sap",
  "data",
  "storage",
  "backup",
] as const;
export type Domain = (typeof DOMAINS)[number];

export const SIGNALS = ["it_move", "financial", "cyber", "corporate"] as const;
export type Signal = (typeof SIGNALS)[number];

export type EntityKind = "customer" | "peer" | "vendor";

export interface Feed {
  kind: "rss" | "edgar" | "ir_page" | "news";
  url?: string;
  cik?: string;
  verifiedAt?: string;
  note?: string;
}

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  domains: Domain[];
  peers: string[];
  feeds: Feed[];
}

export interface TopicQuery {
  query: string;
  domains: Domain[];
}

export interface Watchlist {
  entities: Map<string, Entity>;
  topics: TopicQuery[];
  priority: string[];
  // Informational notes collected while parsing (e.g. a peer with no separate
  // definition, auto-created from a customer's peer list). These never cause
  // a parse to fail; they are returned on every successful parse so callers
  // can see what was inferred, and are also folded into a thrown
  // WatchlistError's message when the parse fails for an unrelated reason.
  notes: string[];
}

export class WatchlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistError";
  }
}

// ---- type guards --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}

// ---- small parsing helpers, collecting problems rather than throwing ---

function parseStringArray(value: unknown, label: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item);
    } else {
      errors.push(`${label} contains a non-string entry`);
    }
  }
  return result;
}

const KNOWN_FEED_KINDS = new Set(["rss", "edgar", "ir_page", "news"]);

function parseFeeds(value: unknown, label: string, errors: string[]): Feed[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    errors.push(`${label} feeds must be an object`);
    return [];
  }

  const feeds: Feed[] = [];
  for (const [kind, rawEntry] of Object.entries(value)) {
    if (!KNOWN_FEED_KINDS.has(kind)) {
      errors.push(`${label} has an unknown feed kind "${kind}"`);
      continue;
    }
    if (kind === "rss" || kind === "news") {
      const urls = parseStringArray(rawEntry, `${label} ${kind} feed`, errors);
      for (const url of urls) feeds.push({ kind, url });
    } else if (kind === "edgar") {
      if (typeof rawEntry !== "string") {
        errors.push(`${label} edgar feed must be a string CIK`);
        continue;
      }
      feeds.push({ kind: "edgar", cik: rawEntry });
    } else {
      // ir_page
      if (typeof rawEntry !== "string") {
        errors.push(`${label} ir_page feed must be a string URL`);
        continue;
      }
      feeds.push({ kind: "ir_page", url: rawEntry });
    }
  }
  return feeds;
}

// A bare vendor/peer id has no display name of its own in the config; derive
// a readable one from the kebab-case id (e.g. "google-cloud" -> "Google Cloud").
function humanize(id: string): string {
  return id
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---- main parser ----------------------------------------------------------

export function parseWatchlist(raw: unknown): Watchlist {
  if (!isRecord(raw)) {
    throw new WatchlistError("watchlist config must be an object");
  }

  const errors: string[] = [];
  // Notes about entities that had to be inferred (e.g. a peer with no
  // separate definition). These never fail a parse on their own; they are
  // only surfaced alongside real errors, for debugging context.
  const notes: string[] = [];

  const entities = new Map<string, Entity>();
  const customerIds: string[] = [];
  const peerIds: string[] = [];
  const vendorIds: string[] = [];

  function addEntity(id: string, entity: Entity, priorityList: string[]): void {
    if (entities.has(id)) {
      errors.push(`duplicate id "${id}"`);
      return;
    }
    entities.set(id, entity);
    priorityList.push(id);
  }

  // --- customers ---
  const customersRaw = raw.customers;
  if (customersRaw !== undefined && !isRecord(customersRaw)) {
    errors.push('"customers" must be an object');
  }
  const customerEntries = isRecord(customersRaw) ? Object.entries(customersRaw) : [];

  for (const [id, value] of customerEntries) {
    if (!isRecord(value)) {
      errors.push(`customer "${id}" must be an object`);
      continue;
    }
    let name = id;
    if (typeof value.name === "string") {
      name = value.name;
    } else {
      errors.push(`customer "${id}" is missing a "name"`);
    }
    const aliases = parseStringArray(value.aliases, `customer "${id}" aliases`, errors);
    const peers = parseStringArray(value.peers, `customer "${id}" peers`, errors);
    const feeds = parseFeeds(value.feeds, `customer "${id}"`, errors);
    addEntity(id, { id, name, kind: "customer", aliases, domains: [], peers, feeds }, customerIds);
  }

  // --- vendors ---
  const vendorsRaw = raw.vendors;
  if (vendorsRaw !== undefined && !isRecord(vendorsRaw)) {
    errors.push('"vendors" must be an object');
  }
  const vendorEntries = isRecord(vendorsRaw) ? Object.entries(vendorsRaw) : [];

  for (const [groupKey, value] of vendorEntries) {
    if (!isDomain(groupKey)) {
      errors.push(`vendor group "${groupKey}" is not a known domain`);
      continue;
    }
    const ids = parseStringArray(value, `vendor group "${groupKey}"`, errors);
    for (const vendorId of ids) {
      const existing = entities.get(vendorId);
      if (existing !== undefined) {
        // A vendor spanning several domains (e.g. Databricks: both "ai" and
        // "data") is listed once per domain group by design; merge domains
        // instead of treating the repeat as a duplicate id. But the same id
        // twice within the SAME group's array is a config typo (R4), not a
        // multi-domain vendor, and is a hard error. Any other entity kind
        // reusing this id is a genuine cross-section collision.
        if (existing.kind === "vendor") {
          if (existing.domains.includes(groupKey)) {
            errors.push(`duplicate id "${vendorId}" within vendor group "${groupKey}"`);
          } else {
            existing.domains.push(groupKey);
          }
        } else {
          errors.push(`duplicate id "${vendorId}"`);
        }
        continue;
      }
      addEntity(
        vendorId,
        { id: vendorId, name: humanize(vendorId), kind: "vendor", aliases: [], domains: [groupKey], peers: [], feeds: [] },
        vendorIds,
      );
    }
  }

  // --- peers implied by customers' peer lists ---
  // Snapshot the customer entities before mutating `entities` with new peers.
  const customerEntitiesSnapshot = customerIds
    .map((id) => entities.get(id))
    .filter((entity): entity is Entity => entity !== undefined);

  for (const customer of customerEntitiesSnapshot) {
    for (const peerId of customer.peers) {
      if (entities.has(peerId)) continue; // already a customer, vendor or earlier peer
      notes.push(`peer "${peerId}" referenced by "${customer.id}" has no separate definition; auto-created`);
      entities.set(peerId, {
        id: peerId,
        name: humanize(peerId),
        kind: "peer",
        aliases: [],
        domains: [],
        peers: [],
        feeds: [],
      });
      peerIds.push(peerId);
    }
  }

  // --- topics ---
  const topicsRaw = raw.topics;
  if (topicsRaw !== undefined && !isRecord(topicsRaw)) {
    errors.push('"topics" must be an object');
  }
  const topicEntries = isRecord(topicsRaw) ? Object.entries(topicsRaw) : [];

  const topics: TopicQuery[] = [];
  for (const [groupKey, value] of topicEntries) {
    let domains: Domain[];
    if (groupKey === "none") {
      domains = [];
    } else if (isDomain(groupKey)) {
      domains = [groupKey];
    } else {
      errors.push(`topic group "${groupKey}" is not a known domain or "none"`);
      continue;
    }
    const queries = parseStringArray(value, `topic group "${groupKey}"`, errors);
    for (const query of queries) {
      topics.push({ query, domains });
    }
  }

  if (errors.length > 0) {
    throw new WatchlistError([...errors, ...notes].join("\n"));
  }

  return {
    entities,
    topics,
    priority: [...customerIds, ...peerIds, ...vendorIds],
    notes,
  };
}

export function loadWatchlist(path: string = "config/watchlist.yaml"): Watchlist {
  const resolvedPath = resolve(process.cwd(), path);
  const contents = readFileSync(resolvedPath, "utf8");
  const document: unknown = parseYamlDocument(contents);
  return parseWatchlist(document);
}

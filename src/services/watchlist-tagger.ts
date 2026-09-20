// Watchlist item tagger.
//
// Tags a RawItem with the closed watchlist vocabulary -- entities, domains,
// a signal and an importance score -- using the local chat model. Every
// downstream digest sentence rests on these tags, so the closed vocabulary
// is enforced here, at the boundary, exactly like watchlist-store.ts
// enforces it again at the storage boundary: an id or domain the model
// invents rather than picks from the watchlist is dropped, never stored.
//
// Everything here is local: TaggerDeps.chat is injected by the caller
// (never getLlmClient() called from this module), so there is no code path
// by which tagging can reach a cloud model.

import { DOMAINS, SIGNALS, type Domain, type Entity, type Signal, type Watchlist } from "./watchlist-config.js";
import type { RawItem } from "./watchlist-sources.js";
import type { ChatMessage, ChatOptions } from "./llm-client.js";

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);
const SIGNAL_SET: ReadonlySet<string> = new Set(SIGNALS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownDomain(value: unknown): value is Domain {
  return typeof value === "string" && DOMAIN_SET.has(value);
}

function isKnownSignal(value: unknown): value is Signal {
  return typeof value === "string" && SIGNAL_SET.has(value);
}

// A valid importance is an integer 1-5. Anything else (out of range,
// fractional, a string, missing) is not a parse failure on its own -- the
// rest of the reply may still be usable -- but the score itself becomes
// null and the whole tagging is flagged for human review (R3 of the brief).
function isValidImportance(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

export interface Tagging {
  summary: string;
  entities: string[];
  domains: Domain[];
  signal: Signal | null;
  importance: number | null;
  facts: Record<string, unknown> | null;
  flagged: boolean;
}

export interface TaggerDeps {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  watchlist: Watchlist;
}

// ---- prompt -----------------------------------------------------------

// Renders one candidate entity as "id (Name; alias: A, alias: B)" so the
// model can match either the canonical name or an alias (e.g. "Genentech")
// back to the id it must actually return.
function describeCandidate(entity: Entity): string {
  const aliasSuffix = entity.aliases.length > 0 ? `; aliases: ${entity.aliases.join(", ")}` : "";
  return `- ${entity.id} (${entity.name}${aliasSuffix})`;
}

// Builds the two-message chat prompt for one item. `candidateIds` is the
// caller's job to compute (the entities whose name or an alias appears in
// the item, plus the feed's own entity) -- this function only renders
// whichever ids it is given, and never reaches into the full watchlist for
// anything beyond looking those ids up. That is what keeps the prompt short
// with ~71 entities in the watchlist: only the handful of candidates ever
// appear in the text sent to the model.
export function buildTaggingPrompt(item: RawItem, watchlist: Watchlist, candidateIds: string[]): ChatMessage[] {
  const candidates = candidateIds
    .map((id) => watchlist.entities.get(id))
    .filter((entity): entity is Entity => entity !== undefined);

  const entityList =
    candidates.length > 0
      ? candidates.map(describeCandidate).join("\n")
      : "(none -- no watched entity's name or alias appears in this item)";

  const system = [
    "You are a tagging engine for a pharma IT-watchlist digest. You read one news item and return ONE JSON object, nothing else.",
    "",
    "Return exactly this shape, with no extra keys:",
    '{"summary": string, "entities": string[], "domains": string[], "signal": string | null, "importance": number, "facts": object | null}',
    "",
    "Rules (closed vocabularies -- any value outside these lists is invalid and will be discarded):",
    "- entities: pick ZERO OR MORE ids ONLY from the candidate list below. Never invent an id, and never return an id that is not in this list, even if the company is mentioned elsewhere.",
    "Candidate entities for this item:",
    entityList,
    "",
    `- domains: pick zero or more values ONLY from: ${DOMAINS.join(", ")}.`,
    `- signal: pick exactly one value from: ${SIGNALS.join(", ")}, or null if none applies.`,
    "- importance: an integer from 1 to 5, rating how much this item matters to the watchlist:",
    "  5 = a named customer's strategic IT or financial move (a platform switch, a major outage, an acquisition, a large contract).",
    "  3 = a named customer or vendor has a smaller, still concrete IT-relevant development.",
    "  1 = routine vendor noise (a minor product update, a generic press release) with no clear link to a watched entity's strategy.",
    "  Use the full range between those anchors; never omit importance.",
    "- facts: a small object of structured details worth keeping (e.g. {\"vendor\": \"aws\", \"dealSize\": \"multi-year\"}), or null if there is nothing structured to extract.",
    "- summary: one or two plain-English sentences, no markdown.",
    "",
    "Respond with the JSON object only -- no prose before or after it, no markdown code fence.",
  ].join("\n");

  const user = [
    `Title: ${item.title}`,
    `Source: ${item.sourceName} (${item.sourceKind})`,
    `Published: ${item.publishedAt}`,
    "Body:",
    item.body,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---- parsing ------------------------------------------------------------

// Extracts the first balanced {...} block from `raw`, tolerating prose
// before/after and a ```json fence -- the local 27B model wraps its JSON in
// both often enough that a bare JSON.parse(raw) would fail far too often.
// Brace matching tracks string literals (and escapes within them) so a
// brace character inside a quoted summary never desyncs the depth count.
function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === "\\") {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null; // braces never balanced -- truncated/garbled reply
}

// Parses a raw model reply into a Tagging, or null when the reply carries no
// recoverable JSON object at all (createTagger's cue to retry). Once a JSON
// object is found, every field is validated independently against its
// closed vocabulary: an unknown entity id or domain is dropped (not fatal),
// an invalid importance becomes null and flags the tagging, but none of
// that turns the whole parse into a null result -- only a missing/unparseable
// JSON block does.
export function parseTagging(raw: string, watchlist: Watchlist): Tagging | null {
  const block = extractJsonBlock(raw);
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const summary = typeof parsed.summary === "string" ? parsed.summary : "";

  const entities = Array.isArray(parsed.entities)
    ? parsed.entities.filter((value): value is string => typeof value === "string" && watchlist.entities.has(value))
    : [];

  const domains = Array.isArray(parsed.domains) ? parsed.domains.filter(isKnownDomain) : [];

  const signal = isKnownSignal(parsed.signal) ? parsed.signal : null;

  let importance: number | null = null;
  let flagged = false;
  if (parsed.importance !== undefined && parsed.importance !== null) {
    if (isValidImportance(parsed.importance)) {
      importance = parsed.importance;
    } else {
      // Present but outside 1-5 or non-integer: drop the score, flag for review.
      flagged = true;
    }
  }

  const facts = isRecord(parsed.facts) ? parsed.facts : null;

  return { summary, entities, domains, signal, importance, facts, flagged };
}

// ---- tagger ---------------------------------------------------------------

// The flagged fallback returned when neither chat call yields a parseable
// reply: no tags, the item's own title standing in for a summary so the
// digest still has something to show, and flagged=true so a human can go
// look at what the model actually said.
function unparseableFallback(item: RawItem): Tagging {
  return {
    summary: item.title,
    entities: [],
    domains: [],
    signal: null,
    importance: null,
    facts: null,
    flagged: true,
  };
}

// Builds the tagging function for one run. Retries the chat call exactly
// once on an unparseable reply (two chat calls total, at most) before
// falling back -- the local model occasionally drops a stray token that
// breaks JSON.parse but produces a clean reply on a second try; retrying
// forever would just burn the run's time budget on a genuinely broken
// prompt or model.
export function createTagger(deps: TaggerDeps): (item: RawItem, candidateIds: string[]) => Promise<Tagging> {
  return async (item, candidateIds) => {
    const messages = buildTaggingPrompt(item, deps.watchlist, candidateIds);

    const firstReply = await deps.chat(messages);
    const firstTagging = parseTagging(firstReply, deps.watchlist);
    if (firstTagging !== null) return firstTagging;

    const secondReply = await deps.chat(messages);
    const secondTagging = parseTagging(secondReply, deps.watchlist);
    if (secondTagging !== null) return secondTagging;

    return unparseableFallback(item);
  };
}

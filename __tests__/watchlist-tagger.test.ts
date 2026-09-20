import { describe, expect, it } from "@jest/globals";
import type { Entity, Watchlist } from "../src/services/watchlist-config.js";
import type { RawItem } from "../src/services/watchlist-sources.js";
import type { ChatMessage } from "../src/services/llm-client.js";
import { buildTaggingPrompt, createTagger, parseTagging, type TaggerDeps } from "../src/services/watchlist-tagger.js";

// ---- fixtures --------------------------------------------------------------

function entity(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    kind: "customer",
    aliases: [],
    domains: [],
    peers: [],
    feeds: [],
    ...overrides,
  };
}

const ROCHE = entity({ id: "roche", name: "Roche", kind: "customer", aliases: ["Genentech"] });
const AWS = entity({ id: "aws", name: "AWS", kind: "vendor", aliases: ["Amazon Web Services"], domains: ["cloud"] });
const NOVARTIS = entity({ id: "novartis", name: "Novartis", kind: "peer" });

const WATCHLIST: Watchlist = {
  entities: new Map([
    ["roche", ROCHE],
    ["aws", AWS],
    ["novartis", NOVARTIS],
  ]),
  topics: [],
  priority: ["roche", "aws", "novartis"],
  notes: [],
};

const ITEM: RawItem = {
  title: "Roche picks AWS for its new R&D data lake",
  url: "https://example.com/a",
  publishedAt: "2026-09-18T00:00:00.000Z",
  body: "Roche announced a multi-year deal with AWS to migrate its research data platform to the cloud.",
  sourceKind: "rss",
  sourceName: "Roche IR",
  titleKey: "roche picks aws for its new rd data lake",
};

function fakeChat(replies: string[]): TaggerDeps["chat"] {
  const queue = [...replies];
  return async (_messages: ChatMessage[]) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fakeChat: no more replies queued");
    return next;
  };
}

const WELL_FORMED_REPLY = JSON.stringify({
  summary: "Roche is migrating its R&D data platform to AWS.",
  entities: ["roche", "aws"],
  domains: ["cloud", "data"],
  signal: "it_move",
  importance: 5,
  facts: { vendor: "aws" },
});

describe("buildTaggingPrompt", () => {
  it("lists only candidateIds, never the whole watchlist, and instructs strict JSON", () => {
    const messages = buildTaggingPrompt(ITEM, WATCHLIST, ["roche", "aws"]);
    const text = messages.map((m) => m.content).join("\n");

    // Candidates are present by id and name/alias.
    expect(text).toContain("roche");
    expect(text).toContain("Roche");
    expect(text).toContain("aws");
    expect(text).toContain("AWS");

    // The non-candidate entity never leaks into the prompt.
    expect(text).not.toContain("novartis");
    expect(text).not.toContain("Novartis");

    // Strict JSON instruction and importance rubric are present.
    expect(text.toLowerCase()).toContain("json");
    expect(text).toContain("5");
    expect(text).toContain("1");

    // Only roles llm-client understands.
    for (const message of messages) {
      expect(["system", "user"]).toContain(message.role);
    }
  });

  it("still produces a valid prompt when there are no candidate entities", () => {
    const genericItem: RawItem = {
      title: "Generic pharma manufacturing update",
      url: "https://example.com/b",
      publishedAt: "2026-09-18T00:00:00.000Z",
      body: "A routine industry update with no named customer or vendor.",
      sourceKind: "news",
      sourceName: "Google News",
      titleKey: "generic pharma manufacturing update",
    };
    const messages = buildTaggingPrompt(genericItem, WATCHLIST, []);
    expect(messages.length).toBeGreaterThan(0);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("Roche");
    expect(text).not.toContain("AWS");
  });
});

describe("parseTagging", () => {
  it("turns a well-formed JSON reply into a Tagging", () => {
    const tagging = parseTagging(WELL_FORMED_REPLY, WATCHLIST);
    expect(tagging).toEqual({
      summary: "Roche is migrating its R&D data platform to AWS.",
      entities: ["roche", "aws"],
      domains: ["cloud", "data"],
      signal: "it_move",
      importance: 5,
      facts: { vendor: "aws" },
      flagged: false,
    });
  });

  it("drops unknown entity ids and unknown domains but keeps the rest", () => {
    const raw = JSON.stringify({
      summary: "s",
      entities: ["roche", "not-a-real-entity"],
      domains: ["cloud", "not-a-real-domain"],
      signal: "it_move",
      importance: 3,
      facts: null,
    });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche"]);
    expect(tagging?.domains).toEqual(["cloud"]);
    expect(tagging?.flagged).toBe(false);
  });

  it("turns an out-of-range importance into null and flags the tagging", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: [], signal: null, importance: 9 });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.importance).toBeNull();
    expect(tagging?.flagged).toBe(true);
  });

  it("turns a non-integer importance into null and flags the tagging", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: [], signal: null, importance: 3.5 });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.importance).toBeNull();
    expect(tagging?.flagged).toBe(true);
  });

  it("parses JSON wrapped in prose", () => {
    const raw = `Sure, here is the tagging you asked for:\n${WELL_FORMED_REPLY}\nLet me know if you need anything else.`;
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche", "aws"]);
    expect(tagging?.importance).toBe(5);
  });

  it("parses JSON wrapped in a ```json fence", () => {
    const raw = "```json\n" + WELL_FORMED_REPLY + "\n```";
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche", "aws"]);
    expect(tagging?.signal).toBe("it_move");
  });

  it("returns null for a reply with no JSON object at all", () => {
    expect(parseTagging("I cannot help with that.", WATCHLIST)).toBeNull();
  });

  it("returns null for a reply whose braces never balance", () => {
    expect(parseTagging('{"summary": "s", "entities": [', WATCHLIST)).toBeNull();
  });

  it("keeps domains and returns entities: [] when nothing matches", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: ["cyber"], signal: null, importance: null });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual([]);
    expect(tagging?.domains).toEqual(["cyber"]);
  });
});

describe("createTagger", () => {
  it("returns the parsed tagging on a well-formed first reply", async () => {
    const chat = fakeChat([WELL_FORMED_REPLY]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, ["roche", "aws"]);

    expect(tagging.entities).toEqual(["roche", "aws"]);
    expect(tagging.flagged).toBe(false);
  });

  it("retries once on an unparseable reply, then succeeds", async () => {
    const chat = fakeChat(["not json at all", WELL_FORMED_REPLY]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, ["roche", "aws"]);

    expect(tagging.entities).toEqual(["roche", "aws"]);
    expect(tagging.flagged).toBe(false);
  });

  it("returns a flagged tagging with the item's title as summary after two unparseable replies", async () => {
    const chat = fakeChat(["still not json", "nope, still nothing"]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, ["roche", "aws"]);

    expect(tagging).toEqual({
      summary: ITEM.title,
      entities: [],
      domains: [],
      signal: null,
      importance: null,
      facts: null,
      flagged: true,
    });
  });

  it("never calls chat more than twice", async () => {
    const calls: ChatMessage[][] = [];
    const chat: TaggerDeps["chat"] = async (messages) => {
      calls.push(messages);
      return "garbage";
    };
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    await tagger(ITEM, ["roche", "aws"]);

    expect(calls.length).toBe(2);
  });

  it("keeps domains and returns entities: [] for an item with no matching entity", async () => {
    const reply = JSON.stringify({
      summary: "General pharma manufacturing news, no named IT vendor.",
      entities: [],
      domains: ["mfg_it"],
      signal: null,
      importance: 2,
      facts: null,
    });
    const chat = fakeChat([reply]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, []);

    expect(tagging.entities).toEqual([]);
    expect(tagging.domains).toEqual(["mfg_it"]);
  });
});

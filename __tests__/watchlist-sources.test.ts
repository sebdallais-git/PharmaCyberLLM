import { describe, expect, it } from "@jest/globals";
import {
  canonicalUrl,
  contentHash,
  newsAdapter,
  rssAdapter,
  type AdapterDeps,
  type FetchLike,
} from "../src/services/watchlist-sources.js";
import type { Entity, Feed } from "../src/services/watchlist-config.js";

const FIXED_NOW = new Date("2026-09-20T12:00:00.000Z");

// Never fetches a real feed/search: every adapter test injects this instead.
function fakeFetch(status: number, body: string): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

function testDeps(fetchImpl: FetchLike): AdapterDeps {
  return { fetchImpl, now: () => FIXED_NOW, userAgent: "PharmaLLM-Test/1.0" };
}

const ENTITY: Entity = {
  id: "roche",
  name: "Roche",
  kind: "customer",
  aliases: [],
  domains: [],
  peers: [],
  feeds: [],
};

// The query string carries a tracking param on purpose: the "non-200" tests
// assert the adapter's error never leaks it.
const RSS_FEED: Feed = { kind: "rss", url: "https://example.com/feed.xml?ref=abc" };

const RSS_BODY = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Roche announces cloud migration</title>
      <link>https://example.com/a</link>
      <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Old item, before the cutoff</title>
      <link>https://example.com/old</link>
      <pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_BODY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom announcement</title>
    <link rel="alternate" href="https://example.com/atom/a"/>
    <updated>2026-09-16T09:30:00Z</updated>
  </entry>
</feed>`;

const SINCE_CUTOFF = "2026-09-01T00:00:00.000Z";

describe("rssAdapter", () => {
  it("parses an RSS 2.0 body into RawItem[] with ISO dates", async () => {
    const adapter = rssAdapter(testDeps(fakeFetch(200, RSS_BODY)));
    const items = await adapter(RSS_FEED, ENTITY, null);

    expect(items).toEqual([
      {
        title: "Roche announces cloud migration",
        url: "https://example.com/a",
        publishedAt: "2026-09-16T09:30:00.000Z",
        body: "Roche announces cloud migration",
        sourceKind: "rss",
        sourceName: "Roche",
      },
      {
        title: "Old item, before the cutoff",
        url: "https://example.com/old",
        publishedAt: "2026-06-01T00:00:00.000Z",
        body: "Old item, before the cutoff",
        sourceKind: "rss",
        sourceName: "Roche",
      },
    ]);
  });

  it("parses an Atom body likewise", async () => {
    const adapter = rssAdapter(testDeps(fakeFetch(200, ATOM_BODY)));
    const items = await adapter(RSS_FEED, ENTITY, null);

    expect(items).toEqual([
      {
        title: "Atom announcement",
        url: "https://example.com/atom/a",
        publishedAt: "2026-09-16T09:30:00.000Z",
        body: "Atom announcement",
        sourceKind: "rss",
        sourceName: "Roche",
      },
    ]);
  });

  it("drops items older than since", async () => {
    const adapter = rssAdapter(testDeps(fakeFetch(200, RSS_BODY)));
    const items = await adapter(RSS_FEED, ENTITY, SINCE_CUTOFF);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Roche announces cloud migration");
  });

  it("rejects on a non-200 response, naming the status but never the url's query string", async () => {
    const adapter = rssAdapter(testDeps(fakeFetch(503, "Service unavailable")));

    await expect(adapter(RSS_FEED, ENTITY, null)).rejects.toThrow(/503/);

    try {
      await adapter(RSS_FEED, ENTITY, null);
      throw new Error("expected the adapter to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("ref=abc");
    }
  });

  it("sends the configured user agent on every request", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = init?.headers;
      return { ok: true, status: 200, text: async () => RSS_BODY };
    };
    const adapter = rssAdapter(testDeps(fetchImpl));
    await adapter(RSS_FEED, ENTITY, null);

    expect(seenHeaders?.["User-Agent"]).toBe("PharmaLLM-Test/1.0");
  });

  it("falls back to the injected clock when an item carries no parseable date", async () => {
    const undated = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>No date here</title><link>https://example.com/undated</link></item>
</channel></rss>`;
    const adapter = rssAdapter(testDeps(fakeFetch(200, undated)));
    const items = await adapter(RSS_FEED, ENTITY, null);

    expect(items).toHaveLength(1);
    expect(items[0].publishedAt).toBe(FIXED_NOW.toISOString());
  });
});

describe("newsAdapter", () => {
  it("builds the Google News RSS URL for a query, matching web-search.ts's parameters", async () => {
    let seenUrl: string | undefined;
    const fetchImpl: FetchLike = async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, text: async () => RSS_BODY };
    };
    const adapter = newsAdapter(testDeps(fetchImpl));
    await adapter("Roche cloud migration", null);

    const expectedParams = new URLSearchParams({
      q: "Roche cloud migration",
      hl: "en-US",
      gl: "US",
      ceid: "US:en",
    });
    expect(seenUrl).toBe(`https://news.google.com/rss/search?${expectedParams.toString()}`);
  });

  it("parses the results with sourceKind news and sourceName Google News", async () => {
    const adapter = newsAdapter(testDeps(fakeFetch(200, RSS_BODY)));
    const items = await adapter("Roche cloud migration", null);

    expect(items[0]).toMatchObject({ sourceKind: "news", sourceName: "Google News" });
  });

  it("drops items older than since", async () => {
    const adapter = newsAdapter(testDeps(fakeFetch(200, RSS_BODY)));
    const items = await adapter("Roche cloud migration", SINCE_CUTOFF);

    expect(items).toHaveLength(1);
  });

  it("rejects on a non-200 response, naming the status but never the query", async () => {
    const adapter = newsAdapter(testDeps(fakeFetch(500, "err")));

    try {
      await adapter("Roche cloud migration", null);
      throw new Error("expected the adapter to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("500");
      expect((err as Error).message).not.toContain("Roche cloud migration");
    }
  });
});

describe("canonicalUrl", () => {
  it("gives the same string for the same page reached two different ways", () => {
    const withTracking = canonicalUrl(
      "https://Example.com/Article/?utm_source=rss&utm_medium=feed&fbclid=abc123&id=42#section-2",
    );
    const plain = canonicalUrl("https://example.com/Article?id=42");

    expect(withTracking).toBe(plain);
    // The host is lowercased; the path's own casing is left alone (only the
    // host is documented as case-normalised).
    expect(withTracking).toBe("https://example.com/Article?id=42");
  });

  it("strips gclid as well as utm_* and fbclid", () => {
    const a = canonicalUrl("https://example.com/a?gclid=xyz");
    const b = canonicalUrl("https://example.com/a");

    expect(a).toBe(b);
  });

  it("keeps meaningful query params", () => {
    const result = canonicalUrl("https://example.com/press?id=42&lang=en");

    expect(result).toContain("id=42");
    expect(result).toContain("lang=en");
  });

  it("drops a trailing slash but leaves a bare root path alone", () => {
    expect(canonicalUrl("https://example.com/press/")).toBe("https://example.com/press");
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com/");
  });
});

describe("contentHash", () => {
  it("is stable across whitespace and case differences", () => {
    const a = contentHash("Roche  Announces   Deal", "Full text here.");
    const b = contentHash("roche announces deal", "full text  here.");

    expect(a).toBe(b);
  });

  it("differs for different text", () => {
    const a = contentHash("Title one", "Body one");
    const b = contentHash("Title two", "Body two");

    expect(a).not.toBe(b);
  });

  it("returns a sha256 hex digest", () => {
    expect(contentHash("t", "b")).toMatch(/^[0-9a-f]{64}$/);
  });
});

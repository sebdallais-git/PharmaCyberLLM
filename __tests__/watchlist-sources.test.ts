import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  canonicalUrl,
  contentHash,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  MAX_ITEM_BODY_LENGTH,
  newsAdapter,
  parseFeed,
  rssAdapter,
  titleKey,
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
  return { fetchImpl, now: () => FIXED_NOW, userAgent: "PharmaITChat-Test/1.0" };
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
        titleKey: "roche announces cloud migration",
      },
      {
        title: "Old item, before the cutoff",
        url: "https://example.com/old",
        publishedAt: "2026-06-01T00:00:00.000Z",
        body: "Old item, before the cutoff",
        sourceKind: "rss",
        sourceName: "Roche",
        titleKey: "old item before the cutoff",
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
        titleKey: "atom announcement",
      },
    ]);
  });

  it("drops items older than since", async () => {
    const adapter = rssAdapter(testDeps(fakeFetch(200, RSS_BODY)));
    const items = await adapter(RSS_FEED, ENTITY, SINCE_CUTOFF);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Roche announces cloud migration");
  });

  // C2: `since` used to be exclusive, so an item published at exactly the
  // watermark was dropped as already seen. EDGAR filing dates and IR-page
  // dates are day-precision -- always midnight -- so once a watermark reached
  // day D, every OTHER item bearing day D was dropped forever. The cutoff is
  // now inclusive of its own instant; the item already seen is caught by the
  // orchestrator's findByUrl dedupe, before the cap and before the model.
  it("still returns an item published at exactly since, so same-day siblings are not lost", async () => {
    const adapter = rssAdapter(testDeps(fakeFetch(200, RSS_BODY)));
    const items = await adapter(RSS_FEED, ENTITY, "2026-09-16T09:30:00.000Z");

    expect(items.map((item) => item.title)).toContain("Roche announces cloud migration");
  });

  it("returns every item of the watermark's own day, not just the one already seen", async () => {
    // Two items with the identical day-precision timestamp a watermark can
    // hold -- the exact shape an IR page or an EDGAR filing list produces.
    const sameDay = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>First of the day</title>
      <link>https://example.com/first</link>
      <pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second of the day</title>
      <link>https://example.com/second</link>
      <pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
    const adapter = rssAdapter(testDeps(fakeFetch(200, sameDay)));

    const items = await adapter(RSS_FEED, ENTITY, "2026-09-16T00:00:00.000Z");

    expect(items.map((item) => item.title)).toEqual(["First of the day", "Second of the day"]);
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

    expect(seenHeaders?.["User-Agent"]).toBe("PharmaITChat-Test/1.0");
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

// Fix round 1, R12: DEFAULT_ADAPTER_TIMEOUT_MS used to be unused -- nothing
// bounded a request beyond whatever fetchImpl a later task injected did on
// its own. Adapters now arm their own AbortController/timer per request, so
// a fetchImpl that just hangs (never resolves, never rejects on its own)
// still gets interrupted at the deadline, mirroring createFetch's own
// timeout tests above.
describe("adapter self-imposed timeout (R12)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("bounds a hung fetch to DEFAULT_ADAPTER_TIMEOUT_MS instead of hanging forever", async () => {
    jest.useFakeTimers();
    // Never settles on its own -- only rejects if the signal the adapter
    // passes in is aborted, exactly like a real hung fetch() would behave.
    const hungFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    const adapter = rssAdapter(testDeps(hungFetch));

    const resultPromise = adapter(RSS_FEED, ENTITY, null);
    const assertion = expect(resultPromise).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(DEFAULT_ADAPTER_TIMEOUT_MS);
    await assertion;
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

// Fix round 1, R13(a): the reviewer verified a real Roche release arrives
// from Google News titled "... - Yahoo Finance" and linked to an opaque
// news.google.com redirect -- neither canonicalUrl nor contentHash can ever
// match the publisher's own copy of the same story. newsAdapter strips the
// suffix from the stored title itself (not just from titleKey).
describe("newsAdapter title cleanup (R13)", () => {
  it("strips a trailing Google-News publisher suffix from the title", async () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Roche posts record Q3 profit - Yahoo Finance</title>
    <link>https://news.google.com/rss/articles/CBMiabc</link>
    <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
  </item>
</channel></rss>`;
    const adapter = newsAdapter(testDeps(fakeFetch(200, xml)));
    const items = await adapter("Roche Q3", null);

    expect(items[0].title).toBe("Roche posts record Q3 profit");
  });

  it("does not truncate a title whose mid-sentence dash is followed by its own punctuation", async () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Roche - once a generics house - posts record profit, beating estimates.</title>
    <link>https://news.google.com/rss/articles/CBMixyz</link>
    <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
  </item>
</channel></rss>`;
    const adapter = newsAdapter(testDeps(fakeFetch(200, xml)));
    const items = await adapter("Roche", null);

    expect(items[0].title).toBe("Roche - once a generics house - posts record profit, beating estimates.");
  });
});

// Fix round 1, R13(b)/(c): the cross-source dedupe key. Task 7 owns actually
// matching on it (plus its ±3-day window); this only produces the key.
describe("titleKey", () => {
  it("gives the publisher's own title and Google News' suffixed copy the same key", () => {
    const publisherTitle = "Roche posts record Q3 profit";
    const googleNewsTitle = "Roche posts record Q3 profit - Yahoo Finance";

    expect(titleKey(googleNewsTitle)).toBe(titleKey(publisherTitle));
  });

  it("gives genuinely different titles different keys", () => {
    expect(titleKey("Roche posts record Q3 profit")).not.toBe(titleKey("Novartis announces new CFO"));
  });

  it("does not truncate a title containing a mid-sentence dash with its own punctuation", () => {
    const title = "Roche - once a generics house - posts record profit, beating estimates.";
    expect(titleKey(title)).toBe("roche once a generics house posts record profit beating estimates");
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
    expect(canonicalUrl("https://example.com/press?id=42&lang=en")).toBe("https://example.com/press?id=42&lang=en");
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

  // Fix round 1, R14: title and body used to be joined with "\n" and then
  // the SAME whitespace-collapsing regex ate that "\n", so contentHash("A",
  // "B") ("a\nb" -> "a b") collided with contentHash("A B", "") ("a b\n" ->
  // "a b"). This pair must now differ.
  it("no longer collides title+body across the old whitespace-collapsed boundary", () => {
    const a = contentHash("A", "B");
    const b = contentHash("A B", "");

    expect(a).not.toBe(b);
  });
});

// Fix round 1, R11: the reviewer confirmed Roche's real feed has
// multi-paragraph descriptions that were being discarded (body === title).
// parseFeed now captures the item's own text, preferring the longest of
// RSS's <description>/<content:encoded> and Atom's <summary>/<content>.
describe("parseFeed body extraction (R11)", () => {
  it("prefers the longer of description and content:encoded", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Roche press release</title>
    <link>https://example.com/pr</link>
    <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
    <description>Short summary.</description>
    <content:encoded><![CDATA[<p>This is the full, much longer article body with multiple sentences and considerably more detail than the short summary field above.</p>]]></content:encoded>
  </item>
</channel></rss>`;
    const items = parseFeed(xml);

    expect(items[0].body).toBe(
      "This is the full, much longer article body with multiple sentences and considerably more detail than the short summary field above.",
    );
  });

  it("prefers the longer of Atom's summary and content", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom press release</title>
    <link rel="alternate" href="https://example.com/atom/pr"/>
    <updated>2026-09-16T09:30:00Z</updated>
    <summary>Brief.</summary>
    <content type="html"><![CDATA[<p>The full Atom content field, considerably longer than the brief summary above it.</p>]]></content>
  </entry>
</feed>`;
    const items = parseFeed(xml);

    expect(items[0].body).toBe("The full Atom content field, considerably longer than the brief summary above it.");
  });

  it("strips HTML tags and decodes entities in an HTML-laden description", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Roche HTML body</title>
    <link>https://example.com/html</link>
    <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
    <description><![CDATA[<p>Roche &amp; partners announce a deal.<br/>More&nbsp;details to follow.</p>]]></description>
  </item>
</channel></rss>`;
    const items = parseFeed(xml);

    expect(items[0].body).toBe("Roche & partners announce a deal. More details to follow.");
  });

  it("falls back to the title when a feed has no description-shaped tag", () => {
    const items = parseFeed(RSS_BODY);

    expect(items[0].body).toBe(items[0].title);
  });

  it("caps a very long body at MAX_ITEM_BODY_LENGTH", () => {
    const longText = "word ".repeat(2000);
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Long body</title>
    <link>https://example.com/long</link>
    <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
    <description>${longText}</description>
  </item>
</channel></rss>`;
    const items = parseFeed(xml);

    expect(items[0].body.length).toBe(MAX_ITEM_BODY_LENGTH);
  });
});

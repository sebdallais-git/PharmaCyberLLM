import { describe, expect, it } from "@jest/globals";
import { parseFeed, verifyFeed, type FetchLike } from "../src/services/watchlist-sources.js";
import type { Feed } from "../src/services/watchlist-config.js";

// A valid RSS 2.0 body: two items, RFC-822 pubDate, a CDATA title and an
// HTML-escaped-entity title -- both real-world quirks a feed verifier has to
// survive.
const RSS_VALID = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title><![CDATA[Roche & Novartis sign deal]]></title>
      <link>https://example.com/a</link>
      <pubDate>Tue, 15 Sep 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second item &amp; more</title>
      <link>https://example.com/b</link>
      <pubDate>Wed, 16 Sep 2026 09:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

// Atom feed using <updated> rather than <pubDate> -- the real-world quirk
// called out in the task brief.
const ATOM_VALID = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Atom item one</title>
    <link rel="alternate" href="https://example.com/atom/a"/>
    <updated>2026-09-15T08:00:00Z</updated>
  </entry>
  <entry>
    <title>Atom item two</title>
    <link rel="alternate" href="https://example.com/atom/b"/>
    <updated>2026-09-16T09:30:00Z</updated>
  </entry>
</feed>`;

// Well-formed RSS, but neither item carries a date anywhere the parser knows
// to look.
const RSS_NO_DATES = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item><title>No date item one</title><link>https://example.com/x</link></item>
    <item><title>No date item two</title><link>https://example.com/y</link></item>
  </channel>
</rss>`;

const RSS_FEED: Feed = { kind: "rss", url: "https://example.com/feed.xml" };

// Never fetches a real feed: verifyFeed's fetchImpl is always this fake.
function fakeFetch(status: number, body: string): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

describe("verifyFeed", () => {
  it("parses a valid RSS body and reports item count and newest date", async () => {
    const result = await verifyFeed(RSS_FEED, fakeFetch(200, RSS_VALID));
    expect(result).toMatchObject({ ok: true, items: 2, newest: "2026-09-16T09:30:00.000Z" });
  });

  it("reports an HTTP error status verbatim", async () => {
    const result = await verifyFeed(RSS_FEED, fakeFetch(404, "Not Found"));
    expect(result).toMatchObject({ ok: false, error: "HTTP 404" });
  });

  it("fails a non-XML body without throwing", async () => {
    const result = await verifyFeed(RSS_FEED, fakeFetch(200, "Service unavailable, please try later."));
    expect(result.ok).toBe(false);
  });

  it("fails a feed whose items carry no parseable date", async () => {
    const result = await verifyFeed(RSS_FEED, fakeFetch(200, RSS_NO_DATES));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no dated items/);
  });

  it("parses an Atom feed using <updated> instead of <pubDate>", async () => {
    const result = await verifyFeed(RSS_FEED, fakeFetch(200, ATOM_VALID));
    expect(result).toMatchObject({ ok: true, items: 2, newest: "2026-09-16T09:30:00.000Z" });
  });

  it("reports an error rather than throwing when the feed has no url", async () => {
    const noUrlFeed: Feed = { kind: "edgar", cik: "0001114448" };
    const result = await verifyFeed(noUrlFeed, fakeFetch(200, RSS_VALID));
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("parseFeed", () => {
  it("decodes CDATA sections and HTML entities in titles", () => {
    const items = parseFeed(RSS_VALID);
    expect(items.map((item) => item.title)).toEqual(["Roche & Novartis sign deal", "Second item & more"]);
    expect(items.map((item) => item.link)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("extracts Atom entries with their href-style links", () => {
    const items = parseFeed(ATOM_VALID);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Atom item one", link: "https://example.com/atom/a" });
  });
});
